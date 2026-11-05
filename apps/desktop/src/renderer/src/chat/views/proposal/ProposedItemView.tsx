import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { FilePlus2, MessageSquare } from "lucide-react";
import type { ProposalDetail } from "@eo/core";
import { Markdown } from "@eo/ui";
import { assistRoomKey, drawAssistReply } from "../../../shared/assist/useAssistRoom";
import { ipcQuery } from "../../../query/client";
import { itemsKey, useChromeVocabulary } from "../../../query/hooks";
import { useAskAssistant } from "../../askAssistant";
import { Button, Card, Chip, ErrorLine, Facts, GroupLabel, Loading, Notice, ViewHeader } from "../../kit";
import { Part } from "../item/Fields";
import { RefText } from "../items/ItemReference";
import { proposalKey, useProposal } from "./useProposal";

/**
 * A proposed item, open beside the conversation before it is filed
 * (EO-408).
 *
 * Drawn in the item view's terms — the same header, card, parts and
 * facts — because it is what the item will be. What it leaves out is
 * everything an item has only once it exists: a key, a thread, runs, a
 * stepper, somebody it is assigned to, and anywhere to move it. Where the
 * key would be it says it is not filed yet.
 *
 * It is read from `assist:proposal`: the proposal on the run behind the
 * card, which is what approving files. Nothing here is edited. The two
 * things a person can do are the two the card offers — approve the whole
 * proposal, or say what should change, which is a sentence in the
 * conversation and a new proposal in reply.
 *
 * Once the proposal is approved this address has nothing left to be
 * about, so it becomes the created item's own address, in the same tab.
 */

/** What a navigation carries to say which tab it takes the place of (`useCanvasTabs`). */
export interface ReplacesTab {
  replacesTab: string;
}

export function ProposedItemView({ messageId, index, tabKey }: { messageId: string; index: number; tabKey: string }) {
  const vocabulary = useChromeVocabulary();
  const { proposal, loading, error } = useProposal(messageId);

  if (loading) return <Loading />;
  if (error) return <ErrorLine>{error.message}</ErrorLine>;

  const row = proposal?.rows[index];
  if (!proposal || row === undefined) {
    return <p className="text-[13px] text-ink-subtle">That proposed {vocabulary.item.toLowerCase()} is not there any more. Ask the assistant to propose it again.</p>;
  }

  const replaces: ReplacesTab = { replacesTab: tabKey };
  // An amendment is about an item that exists, and opens as that item.
  if (row.kind === "change") {
    return row.itemId === null ? (
      <p className="text-[13px] text-ink-subtle">{row.itemKey} no longer exists.</p>
    ) : (
      <Navigate to={`/items/${row.itemId}`} replace state={replaces} />
    );
  }
  // Approved: the item exists, and this tab is its.
  if (row.created) return <Navigate to={`/items/${row.created.itemId}`} replace state={replaces} />;

  return <Unfiled proposal={proposal} row={row} messageId={messageId} />;
}

type ProposedRow = Extract<ProposalDetail["rows"][number], { kind: "new" }>;

/** "Create 3 tickets", "Create feature and 3 tickets": everything approving makes, in the project's own words. */
export function approveLabel(proposal: Pick<ProposalDetail, "container" | "rows">, words: { item: string; items: string }): string {
  const count = proposal.rows.filter((row) => row.kind === "new").length;
  const counted = `${count} ${(count === 1 ? words.item : words.items).toLowerCase()}`;
  return proposal.container === null ? `Create ${counted}` : `Create ${proposal.container.typeLabel.toLowerCase()} and ${counted}`;
}

/** Why there is no approve button, as a sentence. */
function closedReason(proposal: ProposalDetail): string {
  if (proposal.closed === "superseded") return "This proposal has been replaced by a newer one, so it can no longer be approved. The newer one is in the conversation.";
  if (proposal.closed === "refused") return "This proposal was approved and could not be applied. The reason is in the conversation.";
  if (proposal.closed === "applied") return "This proposal has been approved.";
  return "The conversation this proposal is in has been put away, so it can no longer be approved.";
}

function Unfiled({ proposal, row, messageId }: { proposal: ProposalDetail; row: ProposedRow; messageId: string }) {
  const vocabulary = useChromeVocabulary();
  const queryClient = useQueryClient();
  const ask = useAskAssistant();
  const [problem, setProblem] = useState<string | null>(null);

  // The card's own call, on the card's own message: either button creates everything the proposal holds.
  const approve = useMutation({
    mutationFn: () => ipcQuery("assist:approve", { conversationId: proposal.conversationId, messageId }),
    onSuccess: (result) => {
      setProblem(result.problem);
      // The room, and this proposal under its key: the card loses its button as this view becomes the item.
      // Drawn from the answer first when that chat is the one on show (EO-548); re-read either way.
      drawAssistReply(queryClient, result.conversation);
      void queryClient.invalidateQueries({ queryKey: assistRoomKey });
      void queryClient.invalidateQueries({ queryKey: proposalKey(messageId) });
      void queryClient.invalidateQueries({ queryKey: itemsKey });
    },
    onError: (failure: unknown) => setProblem(failure instanceof Error ? failure.message : String(failure)),
  });

  const under = proposal.container ? `${proposal.container.title} · ${proposal.container.typeLabel}` : row.under ? `${row.under.key} ${row.under.title}` : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ViewHeader
        icon={<FilePlus2 size={15} />}
        title={row.title}
        meta={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Chip>Not filed yet</Chip>
            <span>{row.typeLabel}</span>
          </span>
        }
        actions={
          <>
            {/* Beside the conversation, and from the canvas's own window, which hands over to the main one. Absent only outside both. */}
            {ask ? (
              <Button size="sm" variant="ghost" icon={<MessageSquare size={12} />} onClick={ask}>
                Ask for a change
              </Button>
            ) : null}
            {proposal.canApprove ? (
              <Button size="sm" variant="primary" disabled={approve.isPending} onClick={() => approve.mutate()}>
                {approve.isPending ? "Creating…" : approveLabel(proposal, vocabulary)}
              </Button>
            ) : null}
          </>
        }
      />

      {proposal.canApprove ? null : <Notice role="status">{closedReason(proposal)}</Notice>}
      {problem ? (
        <Notice tone="danger" role="alert">
          <RefText>{problem}</RefText>
        </Notice>
      ) : null}

      <div className="@container min-w-0">
        <div className="grid min-w-0 grid-cols-1 gap-3 @4xl:grid-cols-[minmax(0,1fr)_17rem]">
          <article aria-label={row.title} className="flex min-w-0 flex-col gap-3">
            <Card>
              {row.description.trim() !== "" ? (
                <div className="min-w-0 text-ink">
                  <Markdown>{row.description}</Markdown>
                </div>
              ) : (
                <p className="text-[12.5px] text-ink-subtle">No description.</p>
              )}

              <Part title="Acceptance criteria">
                {row.acceptanceCriteria.length === 0 ? (
                  <p className="text-[12.5px] text-ink-subtle">None proposed.</p>
                ) : (
                  <ul aria-label="Acceptance criteria" className="flex flex-col gap-1.5 text-[13px] text-ink">
                    {row.acceptanceCriteria.map((criterion, at) => (
                      <li key={at} className="flex items-start gap-2">
                        <span aria-hidden className="mt-[3px] h-3.5 w-3.5 shrink-0 rounded-[4px] border-[1.5px] border-line-strong" />
                        <span className="min-w-0">{criterion}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Part>

              {row.waitsOn.length > 0 ? (
                <section aria-label="Dependencies" className="flex min-w-0 flex-col gap-2 border-t border-line/60 pt-3">
                  <GroupLabel>Blocked by</GroupLabel>
                  <ul className="flex flex-col gap-1.5">
                    {row.waitsOn.map((dependency, at) => (
                      <li key={at} className="flex min-w-0 items-center gap-2 text-[13px]">
                        {/* A key only for an item that exists; one proposed beside this has none yet. */}
                        {dependency.key !== null ? <span className="shrink-0 font-mono text-[12px] text-ink-subtle">{dependency.key}</span> : null}
                        <span className="min-w-0 flex-1 truncate text-ink">{dependency.title}</span>
                        {dependency.key === null ? <Chip>Not filed yet</Chip> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </Card>
          </article>

          <aside aria-label="About" className="flex min-w-0 flex-col gap-3 @4xl:self-start">
            <Card>
              <GroupLabel>About</GroupLabel>
              <Facts
                items={[
                  { term: "Status", value: "Not filed yet" },
                  { term: "Pipeline", value: proposal.landsOn?.pipelineName ?? "Not decided" },
                  ...(proposal.landsOn ? [{ term: "Enters at", value: proposal.landsOn.stepName }] : []),
                  ...(under !== null ? [{ term: "Under", value: under }] : []),
                ]}
              />
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}
