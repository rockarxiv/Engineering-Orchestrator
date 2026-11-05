import { useQueryClient } from "@tanstack/react-query";
import type { DiscussionMessage, ModuleView } from "@eo/core";
import { modulesKey, useModulesWithDeleted } from "../../query/hooks";

/**
 * EO's record, in a module's scenario chat, that a case the turn wrote
 * withdrew the module's approval (EO-501): what it offers at this moment.
 *
 * Decided here once, because two layouts draw the scenario chat and must
 * not come to disagree about which button the record gets. That the
 * approval was withdrawn arrives decided from `ipc/conversationView.ts`
 * (`approvalWithdrawn`); the one thing read here is the catalog — whether
 * the module is approved now, however that came about.
 *
 *   * `approve`  — the module is still not approved; the record offers
 *                  Approve, which is `modules:approve`: it runs the tests
 *                  and names each failing case when it refuses.
 *   * `approved` — approved since, here or anywhere else.
 *   * `deleted`  — the module has been deleted since; nothing to offer.
 *   * `waiting`  — the catalog has not answered yet. Not known is not
 *                  the same as gone, so nothing is offered.
 */
export type WithdrawnApprovalOffer = "approve" | "approved" | "deleted" | "waiting";

export interface WithdrawnApprovalState {
  offer: WithdrawnApprovalOffer;
  module: ModuleView | undefined;
  /** Refreshes the catalog — what an approval on the record calls when it goes through. */
  refreshCatalog: () => void;
}

export function useWithdrawnApproval(message: DiscussionMessage): WithdrawnApprovalState {
  const queryClient = useQueryClient();
  const catalog = useModulesWithDeleted();
  const moduleId = message.approvalWithdrawn?.moduleId;
  const module = moduleId === undefined ? undefined : catalog.data?.modules?.find((candidate) => candidate.id === moduleId);

  let offer: WithdrawnApprovalOffer = "waiting";
  if (catalog.data) {
    if (!module || module.archivedAt !== null) offer = "deleted";
    else offer = module.approvedAt === null ? "approve" : "approved";
  }

  return { offer, module, refreshCatalog: () => void queryClient.invalidateQueries({ queryKey: modulesKey }) };
}
