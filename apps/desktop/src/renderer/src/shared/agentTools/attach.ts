import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AttachableKind } from "@eo/core";
import { ipcQuery } from "../../query/client";
import { agentAttachmentsKey } from "../../query/hooks";

/** Every agent's attachments, in one cache entry — see `agentAttachmentsKey`. */
export function useAgentAttachments() {
  const query = useQuery({ queryKey: agentAttachmentsKey, queryFn: () => ipcQuery("agentAttachments:list", {}) });
  const byAgent = new Map((query.data?.attachments ?? []).map((row) => [row.agentId, row]));
  return {
    /** What this agent has, as ids. An agent with nothing attached is absent from the answer, not an error. */
    of: (agentId: string) => byAgent.get(agentId) ?? { agentId, mcpServerIds: [], skillIds: [] },
    isLoading: query.isLoading,
  };
}

interface Tick {
  agentId: string;
  kind: AttachableKind;
  id: string;
  attached: boolean;
}

/**
 * One tick, with its refusal handed back rather than thrown.
 *
 * Two ways this can fail and both end in the same sentence on screen: a
 * `problem` — the agent or the entry was deleted in another window
 * between the list arriving and the click — and a rejected promise,
 * which is what `ipcQuery` turns a refused envelope into. Neither is a
 * programmer error and neither may surface as an unhandled throw.
 */
export function useTick(onProblem: (problem: string | null) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tick: Tick) => ipcQuery("agentAttachments:set", tick),
    onSuccess: async (result) => {
      if (result.problem !== null) {
        onProblem(result.problem);
        return;
      }
      onProblem(null);
      // Both the join and the catalogues: an entry deleted underneath
      // this tick is why the refusal exists, so the list that offered it
      // is refetched too.
      await queryClient.invalidateQueries({ queryKey: agentAttachmentsKey });
    },
    onError: (error: Error) => onProblem(error.message),
  });
}
