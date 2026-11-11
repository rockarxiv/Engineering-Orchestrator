import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Layers } from "lucide-react";
import { proposedItemPath, type AmendedItemRow, type DiscussionMessage, type ProposalSummary, type ProposedItemRow } from "@eo/core";
import { Markdown } from "@eo/ui";
import { ipcQuery } from "../../query/client";
import { useChromeVocabulary } from "../../query/hooks";
import { drawAssistReply } from "../../shared/assist/useAssistRoom";
import { proposalKey } from "../views/proposal/useProposal";
import { addedFieldValues, clearAddedFieldDrafts } from "../views/proposal/addedFieldDrafts";
import { priorityLabel, showsPriorityBadge } from "../../shared/pipeline/priority";
import { Button } from "../kit";

/**
 * A change the assistant proposed to the work, with the button that makes it.
 *
 * Drawn from `message.proposal` (EO-407): the structured proposal behind
 * the card, as the main process read it off the run — the data
 * `assist:approve` files — so the card lists what the button creates. One
 * compact row per item, and no descriptions: a plan of five is five lines
 * rather than a wall of prose in a narrow column.
 *
 * Approval is all or nothing, as it always was. The button is the card's,
 * never a row's, and it is offered only while `canApprove` says so; a card
 * that was approved or replaced keeps its rows and says which happened.
 *
 * A row of new work opens that item beside the conversation (EO-408): as
 * an unfiled item while the proposal stands, and as the item itself, by
 * its key, once approving has created it.
 *
 * A card with no readable proposal behind it falls back to its body, which
 * is what every card drew before.
 */
export function ProposalCard({ message, conversationId, onDone }: { message: DiscussionMessage; conversationId: string; onDone: () => void }) {
  const vocabulary = useChromeVocabulary();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const approve = useMutation({
    mutationFn: () => {
      // What a person set on a proposed item's view for its type's added fields (EO-735), whichever Create is pressed.
      const addedFields = addedFieldValues(message.id);
      return ipcQuery("assist:approve", { conversationId, messageId: message.id, ...(addedFields === undefined ? {} : { addedFields }) });
    },
    onSuccess: (result) => {
      setProblem(result.problem);
      if (result.applied) clearAddedFieldDrafts(message.id);
      // The card as approving left it, before the refetch `onDone` asks
      // for: otherwise the button is back to "Create" in between (EO-548).
      drawAssistReply(queryClient, result.conversation);
      // And the proposal at full length, open beside the chat: it is no
      // longer under the room's key (EO-550).
      void queryClient.invalidateQueries({ queryKey: proposalKey(message.id) });
      onDone();
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });
  const summary = message.proposal ?? null;
  const several = vocabulary.items.toLowerCase();

  return (
    <section aria-label="Proposal" className="flex flex-col gap-2.5 rounded-[14px] bg-canvas-subtle px-4 py-3.5">
      {summary === null ? <Markdown>{message.body}</Markdown> : null}
      {summary?.container ? (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-muted">
          <Layers size={14} className="shrink-0" />
          <b className="min-w-0 truncate text-[13px] font-semibold text-ink">{summary.container.title}</b>
          <span className="shrink-0">
            · {summary.container.typeLabel} · {summary.rows.length} {several}
          </span>
          <PriorityLabel priority={summary.container.priority} />
        </div>
      ) : null}
      {summary?.container?.reference !== undefined ? <ReferenceLine reference={summary.container.reference} /> : null}
      {summary !== null ? (
        <ul aria-label={summary.rows.every((row) => row.kind === "change") ? "Proposed changes" : `Proposed ${several}`} className="flex flex-col gap-1.5">
          {summary.rows.map((row, index) => (
            <li key={index} className="rounded-[10px] bg-canvas px-3 py-2">
              {row.kind === "new" ? <ProposedRow row={row} to={proposedItemPath(message.id, index)} /> : <ChangeRow row={row} />}
            </li>
          ))}
        </ul>
      ) : null}
      {message.canApprove ? (
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}>
            {approve.isPending ? "Applying…" : message.approves === "changes" ? "Apply change" : `Create ${vocabulary.item.toLowerCase()}`}
          </Button>
          <span className="text-[11px] text-ink-subtle">or say what should change</span>
        </div>
      ) : (
        <ClosedLine closed={summary?.closed ?? null} />
      )}
      {/* Not once it is approved: pressed here and in the canvas at once, one press wins and the other has nothing to report. */}
      {problem && summary?.closed !== "applied" ? <p className="text-xs text-danger">{problem}</p> : null}
    </section>
  );
}

/** Why there is no button, where the button would be. Nothing when the main process gave no reason. */
function ClosedLine({ closed }: { closed: ProposalSummary["closed"] }) {
  if (closed === null) return null;
  const said = closed === "applied" ? "Approved." : closed === "refused" ? "Not applied — the reason is in the conversation." : "Replaced by a newer proposal.";
  return <p className="text-[11px] text-ink-subtle">{said}</p>;
}

/**
 * An item the proposal creates: its title and type, what it will be
 * checked against, and what it waits on.
 *
 * The whole row is the link. To the proposed item while it is unfiled,
 * and to the item it became — named by its key — once it is not.
 */
function ProposedRow({ row, to }: { row: ProposedItemRow; to: string }) {
  const [first, ...rest] = row.acceptanceCriteria;
  const created = row.created ?? null;
  return (
    <Link to={created ? `/items/${created.itemId}` : to} className="group/row flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-baseline gap-2">
        {created ? <span className="shrink-0 font-mono text-[12px] text-ink-subtle">{created.key}</span> : null}
        <span className="min-w-0 truncate text-[13px] font-medium text-ink group-hover/row:underline">{row.title}</span>
        <span className="shrink-0 text-[11px] text-ink-subtle">{row.typeLabel}</span>
        <PriorityLabel priority={row.priority} />
      </div>
      {first !== undefined ? (
        <p className="flex min-w-0 gap-1.5 text-[12px] text-ink-muted">
          <span className="min-w-0 truncate">{first}</span>
          {rest.length > 0 ? <span className="shrink-0 text-ink-subtle">+{rest.length} more</span> : null}
        </p>
      ) : null}
      {row.reference !== undefined ? <ReferenceLine reference={row.reference} /> : null}
      {row.under !== null ? (
        <p className="truncate text-[11.5px] text-ink-subtle">
          Under {row.under.key} {row.under.title}
        </p>
      ) : null}
      {row.waitsOn.length > 0 ? (
        <p className="truncate text-[11.5px] text-ink-subtle">
          Waits on {row.waitsOn.map((dependency) => (dependency.key === null ? dependency.title : `${dependency.key} ${dependency.title}`)).join(", ")}
        </p>
      ) : null}
    </Link>
  );
}

/**
 * The priority a proposed item would be created with, named, and nothing
 * at Normal (EO-568) — the same rule the board's badge follows, so a card
 * says "High" where the item it creates will.
 */
function PriorityLabel({ priority }: { priority: number | undefined }) {
  if (priority === undefined || !showsPriorityBadge(priority)) return null;
  return <span className="shrink-0 text-[11px] font-medium text-ink-muted">{priorityLabel(priority)}</span>;
}

/**
 * The Reference a proposed item would be created with (EO-739): on the
 * container for a plan, whose items inherit it, and on the row for a
 * single item. Nothing when the proposal names none.
 */
function ReferenceLine({ reference }: { reference: string }) {
  return <p className="truncate text-[11.5px] text-ink-subtle">Reference {reference}</p>;
}

/** A change to an item that exists: its key, linking to its own view, and what changes. */
function ChangeRow({ row }: { row: AmendedItemRow }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-baseline gap-2">
        {row.itemId !== null ? (
          <Link to={`/items/${row.itemId}`} className="shrink-0 text-[13px] font-semibold text-ink hover:underline">
            {row.itemKey}
          </Link>
        ) : (
          <span className="shrink-0 text-[13px] font-semibold text-ink">{row.itemKey}</span>
        )}
        {row.itemTitle !== null ? <span className="min-w-0 truncate text-[13px] text-ink-muted">{row.itemTitle}</span> : null}
      </div>
      <p className="truncate text-[12px] text-ink-muted">{row.change}</p>
    </div>
  );
}
