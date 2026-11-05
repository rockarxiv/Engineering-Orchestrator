import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DiscussionMessage, ModuleView } from "@eo/core";
import { ipcQuery } from "../../query/client";
import { modulesKey, useModulesWithDeleted } from "../../query/hooks";
import { drawAssistReply } from "../assist/useAssistRoom";

/**
 * A card proposing a change to a module that exists, in the help chat
 * (EO-418): what it offers at this moment, and the Apply behind it.
 *
 * Decided here once, because two layouts draw the card and must not come
 * to disagree about which button it gets. What the card *is* arrives
 * already decided from `ipc/conversationView.ts` — `canApprove` says
 * whether Apply is still offered, `moduleChange` whether it was applied
 * and whether the catalog still holds what it saved. The one thing read
 * here is the catalog: whether the module is approved now, however that
 * came about.
 *
 *   * `apply`     — nothing is saved yet; the person may press Apply.
 *   * `approve`   — applied, and the module is waiting to be approved
 *                   again. Offered where the change was applied, so
 *                   nobody is sent to Settings → Modules for it.
 *   * `approved`  — applied, and approved since.
 *   * `moved`     — applied, and the module has been changed again, so
 *                   Approve here would approve code this card never
 *                   showed.
 *   * `deleted`   — applied, and the module has been deleted since.
 *   * `closed`    — never applied, and no longer the newest thing said:
 *                   the diff stays readable and nothing is offered.
 */
export type ModuleChangeOffer = "apply" | "approve" | "approved" | "moved" | "deleted" | "closed";

export interface ModuleChangeCardState {
  offer: ModuleChangeOffer;
  /** The module as the catalog holds it, once the catalog has answered. */
  module: ModuleView | undefined;
  apply: () => void;
  applying: boolean;
  /** Why Apply was refused, or null. */
  problem: string | null;
  /** Refreshes the catalog — what an approval on the card calls when it goes through. */
  refreshCatalog: () => void;
}

export function useModuleChangeCard(message: DiscussionMessage, conversationId: string, onDone: () => void): ModuleChangeCardState {
  const queryClient = useQueryClient();
  const catalog = useModulesWithDeleted();
  const [problem, setProblem] = useState<string | null>(null);
  const refreshCatalog = () => void queryClient.invalidateQueries({ queryKey: modulesKey });

  const applying = useMutation({
    mutationFn: () => ipcQuery("assist:applyChange", { conversationId, messageId: message.id }),
    onSuccess: (result) => {
      setProblem(result.problem);
      // The card as applying left it, without waiting on a refetch (EO-548).
      drawAssistReply(queryClient, result.conversation);
      if (result.applied) refreshCatalog();
      onDone();
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  const change = message.moduleChange ?? null;
  const module = change === null ? undefined : catalog.data?.modules?.find((candidate) => candidate.id === change.moduleId);

  let offer: ModuleChangeOffer = "closed";
  if (message.canApprove) offer = "apply";
  else if (change?.applied) {
    // Not known yet is not the same as gone: until the catalog answers, an applied card offers nothing rather than guessing.
    if (!catalog.data) offer = "closed";
    else if (!module || module.archivedAt !== null) offer = "deleted";
    else if (!change.describesSaved) offer = "moved";
    else offer = module.approvedAt === null ? "approve" : "approved";
  }

  return { offer, module, apply: () => applying.mutate(), applying: applying.isPending, problem, refreshCatalog };
}

/** What an applied card says in place of a button, or null where it has a button or nothing to add. */
export function moduleChangeNote(offer: ModuleChangeOffer, name: string): string | null {
  if (offer === "approved") return `Applied, and ${name} has been approved since.`;
  if (offer === "moved") return `Applied — and ${name} has been changed again since, so this card no longer describes it. It is approved on its newest card, or in Settings → Modules.`;
  if (offer === "deleted") return "Applied — and the module has been deleted since, so there is nothing here to approve.";
  return null;
}
