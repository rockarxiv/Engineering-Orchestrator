import type { Uuid } from "@eo/core";
import type { Db } from "./client.js";

/**
 * A move to another pipeline version asked of the record, announced
 * (EO-567).
 *
 * `assignmentEvents.ts`' sibling, for its reason: the queue lives in
 * `record/outbound.ts`, and the command that asks should not have to
 * know there is one. Announced only for an item whose record is
 * elsewhere — a desktop that holds the item makes the move itself.
 */
export interface VersionMoveAsked {
  itemId: Uuid;
  version: number;
  /** The id the record's comment will be written under. */
  commentId: Uuid;
  note: string;
}

export type VersionMoveListener = (asked: VersionMoveAsked) => void;

const listeners = new WeakMap<Db, Set<VersionMoveListener>>();

export function onVersionMoveAsked(db: Db, listener: VersionMoveListener): () => void {
  const existing = listeners.get(db) ?? new Set<VersionMoveListener>();
  existing.add(listener);
  listeners.set(db, existing);
  return () => {
    existing.delete(listener);
  };
}

export function notifyVersionMoveAsked(db: Db, asked: VersionMoveAsked): void {
  for (const listener of listeners.get(db) ?? []) {
    try {
      listener(asked);
    } catch (error) {
      console.error("[eo] a version move listener threw:", error);
    }
  }
}
