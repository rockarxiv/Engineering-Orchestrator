import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CHAT_HOME_ROUTE } from "@eo/core";
import { ipcQuery } from "../query/client";
import { useProjects } from "../query/useRepositories";
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
 *
 * The chat is on the project of the pipeline it is about, and is shown on
 * that project's rail (EO-765). Pressed while on another project, the
 * main process has already moved the window there, and the switch is
 * finished here the way the project switcher finishes one: everything
 * project-scoped is asked again.
 */
export function useOpenUpdateConflictChat() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { activeProjectId, setActive } = useProjects();
  const [problem, setProblem] = useState<string | null>(null);

  const open = useMutation({
    mutationFn: (request: { conflictId: string; commentId: string | null }) => ipcQuery("assist:openUpdateConflict", request),
    onSuccess: async (result) => {
      setProblem(result.problem);
      if (result.conversation === null) return;
      if (result.projectId !== null && result.projectId !== activeProjectId) {
        // The switch drops the room and the rail and reads both again once
        // it is through, and the main process has already put this chat on
        // show on that project — so that read answers with it.
        setActive(result.projectId);
        void navigate(CHAT_HOME_ROUTE);
        return;
      }
      // Straight into the cache, as New chat does: the chat just opened is
      // the answer, and the one on show before should not linger. A read
      // of the room begun before the press is cancelled first, or it would
      // land after this and put the old chat back.
      await queryClient.cancelQueries({ queryKey: assistRoomKey, exact: true });
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
