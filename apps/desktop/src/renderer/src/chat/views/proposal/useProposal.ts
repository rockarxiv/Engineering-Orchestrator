import { useQuery } from "@tanstack/react-query";
import type { ProposalDetail } from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { useInvalidateOnPush } from "../../../query/useInvalidateOnPush";

/**
 * The key one proposal is cached under.
 *
 * A root of its own, outside the assistant room's key (EO-550): the room
 * is re-read on every streamed event of its run, and this read with it
 * was one more `assist:proposal` each time. A button that approves the
 * proposal invalidates this key beside the room's, and the pushes below
 * reach a view left open anywhere else.
 */
export function proposalKey(messageId: string): readonly unknown[] {
  return ["assistProposal", messageId];
}

/**
 * A work proposal at full length, by the message its card is (EO-408).
 *
 * `assist:proposal` rather than the conversation the frame already holds,
 * because this is read where there is no conversation: in the canvas's
 * own window, and on a reload that finds the window showing another chat.
 *
 * Re-read on the pushes that can change what it says. An approval creates
 * items; a newer proposal arrives at the end of a run. Both are how a
 * view left open learns its button has gone.
 */
export function useProposal(messageId: string): { proposal: ProposalDetail | null; loading: boolean; error: Error | null } {
  const key = proposalKey(messageId);
  const read = useQuery({ queryKey: key, queryFn: () => ipcQuery("assist:proposal", { messageId }) });
  useInvalidateOnPush("items:changed", key);
  useInvalidateOnPush("runs:changed", key);
  return { proposal: read.data?.proposal ?? null, loading: read.isLoading, error: read.error };
}
