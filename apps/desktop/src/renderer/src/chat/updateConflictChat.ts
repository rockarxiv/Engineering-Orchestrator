import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CHAT_HOME_ROUTE } from "@eo/core";
import { ipcQuery } from "../query/client";
import { assistRoomKey, assistThreadsKey } from "../shared/assist/useAssistRoom";

/**
 * Opening the assistant chat about one held template update (EO-533):
 * what Fix with assistant on the conflict notice does, and what "Update
 * waiting" on a pipeline's head does once that chat exists (EO-536).
 *
 * The main process decides which chat — the one an earlier press opened,
 * while it exists, or a new one with EO's brief — and the renderer sends
 * which conflict, and which notice was pressed where one was. The chat is
 * put on show and the chat home is opened, as New chat does.
 */
export function useOpenUpdateConflictChat() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);

  const open = useMutation({
    mutationFn: (request: { conflictId: string; commentId: string | null }) => ipcQuery("assist:openUpdateConflict", request),
    onSuccess: (result) => {
      setProblem(result.problem);
      if (result.conversation === null) return;
      // Straight into the cache, as New chat does: the chat just opened is
      // the answer, and the one on show before should not linger.
      queryClient.setQueryData(assistRoomKey, { conversation: result.conversation });
      void queryClient.invalidateQueries({ queryKey: assistRoomKey });
      void queryClient.invalidateQueries({ queryKey: assistThreadsKey });
      void navigate(CHAT_HOME_ROUTE);
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  return {
    open: (request: { conflictId: string; commentId: string | null }) => {
      setProblem(null);
      open.mutate(request);
    },
    isPending: open.isPending,
    problem,
  };
}
