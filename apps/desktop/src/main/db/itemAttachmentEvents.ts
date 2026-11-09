import type { Uuid } from "@eo/core";
import type { Db } from "./client.js";
import type { AttachmentRecord } from "./repos/attachmentsRepo.js";

/**
 * An item's own files arriving and leaving (EO-702), for whoever needs
 * to hear — the organisation record's outbound queue
 * (`record/outbound.ts`). Announced by `addItemAttachments` and
 * `removeItemAttachment` only, so what a replica writes on the record's
 * word is never sent back to it. `watchEvents.ts`'s shape.
 */
export interface ItemAttachmentListener {
  added?: (itemId: Uuid, attachments: readonly AttachmentRecord[]) => void;
  removed?: (attachment: AttachmentRecord) => void;
}

const listeners = new WeakMap<Db, Set<ItemAttachmentListener>>();

export function onItemAttachmentsChanged(db: Db, listener: ItemAttachmentListener): () => void {
  const existing = listeners.get(db) ?? new Set<ItemAttachmentListener>();
  existing.add(listener);
  listeners.set(db, existing);
  return () => {
    existing.delete(listener);
  };
}

export function notifyItemAttachmentsAdded(db: Db, itemId: Uuid, attachments: readonly AttachmentRecord[]): void {
  for (const listener of listeners.get(db) ?? []) {
    try {
      listener.added?.(itemId, attachments);
    } catch (error) {
      console.error("[eo] an item attachment listener threw:", error);
    }
  }
}

export function notifyItemAttachmentRemoved(db: Db, attachment: AttachmentRecord): void {
  for (const listener of listeners.get(db) ?? []) {
    try {
      listener.removed?.(attachment);
    } catch (error) {
      console.error("[eo] an item attachment listener threw:", error);
    }
  }
}
