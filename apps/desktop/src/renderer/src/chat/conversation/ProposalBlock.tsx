import type { DiscussionMessage } from "@eo/core";
import { ProposalCard } from "./ProposalCard";
import { PressBlock } from "./PressBlock";
import type { TranscriptRow } from "./QuestionCard";

/** A row of the chat's transcript: a message, a batch of questions, or one reply's proposals. */
export type ChatTranscriptRow = TranscriptRow | { kind: "proposals"; messages: DiscussionMessage[] };

/**
 * One reply's work proposals as one block in the conversation (EO-864):
 * the pager a reply's cards use (`PressBlock`), one proposal on show at a
 * time, drawn exactly as `ProposalCard` draws it alone, with its own
 * button and its rows. A reply with one proposal is that card and nothing
 * more.
 *
 * With two or more open, "Approve all" approves each in order through its
 * own button's call (`assist:approve`). Each stays all or nothing within
 * itself; one that fails keeps its reason, the rest go ahead, and the
 * block then shows the first that failed.
 */
export function ProposalBlock({ messages, conversationId, onDone }: { messages: readonly DiscussionMessage[]; conversationId: string; onDone: () => void }) {
  const pages = messages.map((message) => ({ key: message.id, open: message.canApprove, done: message.proposal?.closed === "applied" }));
  return (
    <PressBlock label="Proposals from the assistant" noun="proposal" pages={pages} doAll>
      {(position, controls) => <ProposalCard message={messages[position]!} conversationId={conversationId} onDone={onDone} {...(controls ?? {})} />}
    </PressBlock>
  );
}

/**
 * Whether the chat draws a message as a work proposal's card: what is
 * left once a module, a module change, action cards and a pipeline draft
 * have had theirs — one that can be approved, or that keeps its rows
 * after it no longer can (EO-407).
 */
export function isProposalCard(message: DiscussionMessage): boolean {
  if (message.authorType === "human" || message.moduleSlug || message.moduleChange) return false;
  if (message.cards && message.cards.length > 0) return false;
  if (message.canApprove && message.approves === "pipeline") return false;
  return message.canApprove || Boolean(message.proposal);
}

/**
 * A transcript's rows with each reply's proposals gathered into one row
 * (EO-864), standing where the reply's first proposal stood. A reply is
 * its run: every proposal one turn posted shares it. Proposals from two
 * replies are two rows, and a reply with one proposal keeps it as the
 * message row it always was.
 */
export function withProposalBlocks(rows: readonly TranscriptRow[]): ChatTranscriptRow[] {
  const proposalOf = (row: TranscriptRow): DiscussionMessage | null => (row.kind === "message" && row.message.runId !== null && isProposalCard(row.message) ? row.message : null);
  const byRun = new Map<string, DiscussionMessage[]>();
  for (const row of rows) {
    const message = proposalOf(row);
    if (message !== null) byRun.set(message.runId!, [...(byRun.get(message.runId!) ?? []), message]);
  }
  const out: ChatTranscriptRow[] = [];
  for (const row of rows) {
    const message = proposalOf(row);
    const batch = message === null ? undefined : byRun.get(message.runId!);
    if (batch === undefined || batch.length < 2) out.push(row);
    else if (batch[0] === message) out.push({ kind: "proposals", messages: batch });
  }
  return out;
}
