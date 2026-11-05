import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { IpcPushChannel, IpcPushPayload } from "@eo/core";
import { bridge } from "../ipc/bridge";

/** Which pushes on a channel a subscriber wants acted on. */
export type PushFilter<C extends IpcPushChannel> = (payload: IpcPushPayload<C>) => boolean;

export interface InvalidateOnPushOptions<C extends IpcPushChannel> {
  /** Listen at all. False for a query that is itself disabled. */
  enabled?: boolean;
  /**
   * Only the pushes this says yes to (EO-560). The pushes are doorbells
   * for the whole installation, and most already say what they are
   * about — `items:changed` its item when it knows it, `runs:changed`
   * its run and item — so a screen about one item can leave every other
   * item's pushes alone. Read on each push, never captured: an inline
   * arrow is fine.
   */
  filter?: PushFilter<C>;
  /**
   * Narrow each push to the item it names (EO-560): `[...queryKey,
   * itemId]` is invalidated rather than all of `queryKey`, and the whole
   * of it only when the push names no item. For a family of per-item
   * queries under one root — every board card's step authority — that is
   * one listener for all of them, and one refetch per push, of the card
   * it is about.
   */
  perItem?: boolean;
}

/**
 * The one push listener a channel and key have in a window, however many
 * components asked for it (EO-560).
 *
 * Each listener used to invalidate the key on its own, and each
 * invalidation cancels the refetch the previous one had just started and
 * starts another: `useProjects` is called from twenty places, several on
 * screen at once, and every `items:changed` asked `projects:list` once
 * per caller. Now the components share one subscription per
 * `(channel, key)`, and a push invalidates the key once if any of them
 * wants it.
 */
interface SharedPush {
  /** One per mounted subscriber: its current filter, or none for every push. */
  listeners: Set<{ current: ((payload: unknown) => boolean) | undefined }>;
  unsubscribe: () => void;
}

const sharedPushes = new WeakMap<QueryClient, Map<string, SharedPush>>();

function pushesOf(queryClient: QueryClient): Map<string, SharedPush> {
  let pushes = sharedPushes.get(queryClient);
  if (!pushes) {
    pushes = new Map();
    sharedPushes.set(queryClient, pushes);
  }
  return pushes;
}

/** The query key a push lands on: the item it names under a per-item root, or the key itself. */
function targetOf(key: unknown[], perItem: boolean, payload: unknown): unknown[] {
  if (!perItem || typeof payload !== "object" || payload === null) return key;
  const itemId = (payload as { itemId?: unknown }).itemId;
  return typeof itemId === "string" ? [...key, itemId] : key;
}

/**
 * Invalidates queries when the main process pushes on `channel`.
 *
 * This is what makes the UI live without polling (U-01): the engine
 * already knows when an item moved or a run produced events, so the
 * renderer reacts to that rather than asking repeatedly.
 *
 * Every component that asks for the same channel and key shares one
 * subscription (see `SharedPush`), so a hook may declare what keeps its
 * own query live without costing a second refetch per push where
 * another component already does the same.
 *
 * The third argument is `enabled` alone, as it always was, or the
 * options above.
 */
export function useInvalidateOnPush<C extends IpcPushChannel>(
  channel: C,
  queryKey: readonly unknown[],
  options: boolean | InvalidateOnPushOptions<C> = true,
): void {
  const queryClient = useQueryClient();
  const { enabled = true, filter, perItem = false } = typeof options === "boolean" ? { enabled: options } : options;
  // Read on each push, so a filter closing over render state is never stale
  // and a new arrow each render does not resubscribe.
  const listener = useRef<((payload: unknown) => boolean) | undefined>(undefined);
  listener.current = filter as ((payload: unknown) => boolean) | undefined;
  // Compared by value, not identity: callers pass an inline array, which
  // is a new object every render and would otherwise tear down and
  // resubscribe the push listener on each one.
  const serializedKey = JSON.stringify(queryKey);

  useEffect(() => {
    if (!enabled) return undefined;
    const pushes = pushesOf(queryClient);
    const id = JSON.stringify([channel, serializedKey, perItem]);
    let shared = pushes.get(id);
    if (!shared) {
      const key = JSON.parse(serializedKey) as unknown[];
      const listeners: SharedPush["listeners"] = new Set();
      const unsubscribe = bridge().subscribe(channel, (payload) => {
        for (const each of listeners) {
          if (each.current === undefined || each.current(payload)) {
            void queryClient.invalidateQueries({ queryKey: targetOf(key, perItem, payload) });
            return;
          }
        }
      });
      shared = { listeners, unsubscribe };
      pushes.set(id, shared);
    }
    const entry = shared;
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size > 0) return;
      entry.unsubscribe();
      if (pushes.get(id) === entry) pushes.delete(id);
    };
  }, [channel, queryClient, serializedKey, enabled, perItem]);
}

/**
 * A push about this item, or about no item in particular (EO-560): the
 * filter a screen showing one item listens with. A push naming no item is
 * the main process saying "something changed" without saying what, and
 * stays a refresh.
 */
export function namesItemOrNone(itemId: string): (payload: { itemId?: string | undefined }) => boolean {
  return (payload) => payload.itemId === undefined || payload.itemId === itemId;
}
