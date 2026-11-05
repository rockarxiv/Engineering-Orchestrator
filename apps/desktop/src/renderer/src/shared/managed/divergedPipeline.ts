import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ipcQuery } from "../../query/client";
import { divergenceKey, pipelinesKey, sectionsKey } from "../../query/hooks";

/**
 * Pushing this machine's copy up as a suggestion.
 *
 * One mutation for both buttons — the one on the lock and the one on
 * the diverged notice — because the design gives them one meaning, and the
 * main process gives them one channel. What comes back is a sentence
 * either way: an item key to quote to an administrator, or why not.
 */
export function useSuggest(pipelineId: string, onSaid?: ((said: string) => void) | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<string> => {
      const answer = await ipcQuery("pipelines:suggest", { pipelineId });
      if (!answer.suggested) return answer.problem ?? "Nothing was suggested.";
      const key = answer.itemKey === null ? "" : ` It is ${answer.itemKey}.`;
      return `Sent to your organisation for an administrator to approve or send back.${key}`;
    },
    onSuccess: (said) => onSaid?.(said),
    onSettled: () => {
      // Suggesting diverges the copy, so what the screen is drawing
      // about itself has changed even where the push failed.
      void queryClient.invalidateQueries({ queryKey: divergenceKey(pipelineId) });
      void queryClient.invalidateQueries({ queryKey: sectionsKey });
    },
  });
}

/** Throwing the local edits away and taking the published version back. */
export function useDiscard(pipelineId: string, onSaid?: ((said: string) => void) | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<string> => {
      const answer = await ipcQuery("pipelines:discardEdits", { pipelineId });
      if (!answer.discarded) return answer.problem ?? "Nothing was discarded.";
      const version = answer.version === null ? "" : ` You are back on v${String(answer.version)}.`;
      return `Your edits are gone and your organisation's version is back.${version}`;
    },
    onSuccess: (said) => onSaid?.(said),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: divergenceKey(pipelineId) });
      void queryClient.invalidateQueries({ queryKey: sectionsKey });
      // The graph itself was just rewritten: every board drawn from it
      // is stale.
      void queryClient.invalidateQueries({ queryKey: pipelinesKey(null) });
    },
  });
}
