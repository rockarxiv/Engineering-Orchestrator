import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { isDispatchable, type DiscussionView, type IpcResponse } from "@eo/core";
import { ipcQuery } from "../../query/client";
import { agentsKey } from "../../query/hooks";
import { useInvalidateOnPush } from "../../query/useInvalidateOnPush";
import { roomIdentity, useRoomPushes } from "../../query/useRoomPushes";

/**
 * The renderer's half of a module's scenario chat (EO-356).
 *
 * `useAssistRoom`, keyed on a module: there is one live thread per
 * module, so the cache key names the module and opening the chat on
 * another module's page is opening another conversation. Everything else
 * is the assistant's arrangement and for its reasons — whether anybody is
 * there to talk to is asked before the room is opened, because opening
 * creates it; the same three pushes keep the transcript live, each only
 * when it is about this thread or its run; a refused
 * send rejects so the composer keeps what was typed.
 */

export const scenarioRoomKey = (moduleId: string) => ["scenario", moduleId] as const;

/**
 * Draws the conversation a write in a module's scenario chat answered
 * with, at once (EO-548): `scenario:answer` and `scenario:apply` carry
 * the thread as it stands afterwards, and re-reading it through
 * `scenario:open` first left a card live after it was answered. The
 * caller still invalidates after it, as the backstop.
 *
 * `useAssistRoom`'s `drawAssistReply`, keyed on the module, and with its
 * rule: only over the thread this room shows, so an answer from a thread
 * Clear has since replaced does not bring it back.
 */
export function drawScenarioReply(queryClient: QueryClient, moduleId: string, conversation: DiscussionView): void {
  const key = scenarioRoomKey(moduleId);
  const shown = queryClient.getQueryData<IpcResponse<"scenario:open">>(key);
  if (shown?.conversation.id !== conversation.id) return;
  queryClient.setQueryData<IpcResponse<"scenario:open">>(key, { conversation });
}

export interface ScenarioRoom {
  /** Is there an enabled system agent to talk to at all? */
  available: boolean;
  conversation: DiscussionView | null;
  loading: boolean;
  /** Why the last clear did not work — the main process's own sentence. */
  problem: string | null;
  /** Rejects when the send is refused, which is `Composer`'s contract. */
  send: (body: string, attachmentIds?: string[]) => Promise<void>;
  sending: boolean;
  clear: () => void;
  clearing: boolean;
  refresh: () => void;
}

export function useScenarioRoom(moduleId: string, open: boolean): ScenarioRoom {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const key = scenarioRoomKey(moduleId);
  // Stable, so the chat can hand it to the live words without re-arming their effects.
  const refresh = useCallback(() => void queryClient.invalidateQueries({ queryKey: scenarioRoomKey(moduleId) }), [queryClient, moduleId]);

  const agents = useQuery({ queryKey: agentsKey, queryFn: () => ipcQuery("agents:list", undefined), enabled: open });
  useInvalidateOnPush("config:changed", agentsKey);
  const available = (agents.data?.agents ?? []).some((agent) => agent.role === "system" && isDispatchable(agent));

  const room = useQuery({
    queryKey: key,
    queryFn: () => ipcQuery("scenario:open", { moduleId }),
    enabled: open && available,
  });

  const view = room.data?.conversation ?? null;
  // Only the pushes about this module's thread and its own run (EO-550).
  useRoomPushes(key, roomIdentity(view));

  const send = useMutation({
    mutationFn: ({ body, attachmentIds }: { body: string; attachmentIds: string[] }) =>
      ipcQuery("scenario:send", { moduleId, conversationId: view?.id ?? null, body, attachmentIds, interrupt: false }),
    onSuccess: (result) => {
      setProblem(null);
      queryClient.setQueryData(key, result);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const clear = useMutation({
    mutationFn: () => ipcQuery("scenario:clear", { moduleId }),
    onSuccess: (result) => {
      setProblem(null);
      // The empty thread is the answer; waiting for a refetch would leave
      // the cleared transcript on screen.
      queryClient.setQueryData(key, result);
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  return {
    available,
    conversation: view,
    loading: agents.isLoading || room.isLoading,
    problem: problem ?? (room.error instanceof Error ? room.error.message : null),
    send: async (body: string, attachmentIds: string[] = []) => {
      await send.mutateAsync({ body, attachmentIds });
    },
    sending: send.isPending,
    clear: () => clear.mutate(),
    clearing: clear.isPending,
    refresh,
  };
}
