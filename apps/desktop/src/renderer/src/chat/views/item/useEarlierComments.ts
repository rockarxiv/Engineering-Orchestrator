import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { CommentView, ItemPage, TransitionView } from "@eo/core";
import { ipcQuery } from "../../../query/client";

/**
 * The item page's thread, a page at a time (EO-559).
 *
 * `items:get` carries the newest stretch of the thread and how many came
 * before it; the rest is read with `items:earlierComments` when somebody
 * asks — the way the assistant's chat pages its history, so a thread
 * megabytes long is neither sent nor drawn whole on every push.
 *
 * Two things keep what is drawn whole and true:
 *
 * - **The page is held still once history is read behind it.** Unheld,
 *   the newest page slides forward as comments arrive, and a comment
 *   that slid out of it between two reads would be in neither the page
 *   nor the history. So the first "Show earlier" holds the page at its
 *   oldest comment (`items:get` with `from`): from then on it is that
 *   comment and everything after it, and history is read strictly
 *   before it, a page at a time, each page before the oldest of the one
 *   above. Nothing can fall between them. Should the comment it was held
 *   at be deleted, the page comes back not starting with it, and the
 *   view lets go — history dropped, the newest page and its count again —
 *   rather than drawing a thread with a hole in it.
 * - **History is refreshed by the backstops, not by every push.** It is
 *   its own query (`itemHistoryKey`), outside the item's own key, so the
 *   pushes that refetch the page do not resend everything read back. It
 *   is read again, every page, on window focus and on reconnect like
 *   every query, and after a person acts on the thread here
 *   (`invalidateHistory`) — an answer to an old question, a pin, a
 *   delete. A refetch recomputes each page's cursor from the page above
 *   it, so a comment deleted elsewhere leaves no gap either.
 */
export interface ItemThread {
  /** The item as `items:get` answers it — every section, the thread windowed. */
  detail: UseQueryResult<ItemPage | null>;
  /** The thread as the page draws it: what has been read back, then the page, oldest first. */
  comments: CommentView[];
  /** How many older comments there are still to read. */
  remaining: number;
  loading: boolean;
  problem: string | null;
  /** Reads the next page back. */
  load: () => void;
  /** Reads what has been read back again — after a person acted on the thread here. */
  invalidateHistory: () => Promise<void>;
}

/** The key the read-back history of an item is cached under: beside the item's own, not under it. */
export function itemHistoryKey(itemId: string) {
  return ["item-history", itemId] as const;
}

/** What has been read back, then the page — the page's copy winning wherever both hold one. */
export function mergedComments(older: readonly CommentView[], page: readonly CommentView[]): CommentView[] {
  const onPage = new Set(page.map((comment) => comment.id));
  return [...older.filter((comment) => !onPage.has(comment.id)), ...page];
}

/**
 * The moves the timeline draws beside the comments it has (EO-559). A
 * thread with older comments still unread starts at the oldest comment
 * on screen, so a move from before it is drawn with the comments around
 * it once they are read, not above a "Show earlier" that would then fill
 * in underneath it.
 */
export function transitionsShown(transitions: readonly TransitionView[], comments: readonly CommentView[], remaining: number): TransitionView[] {
  const oldest = comments[0];
  if (remaining === 0 || oldest === undefined) return [...transitions];
  return transitions.filter((transition) => transition.ts >= oldest.createdAt);
}

export function useItemThread(itemId: string): ItemThread {
  const queryClient = useQueryClient();
  const [held, setHeld] = useState<{ itemId: string; from: string } | null>(null);
  const from = held !== null && held.itemId === itemId ? held.from : null;

  const detail = useQuery({
    // Under the item's own key either way, so every push and write that
    // refreshes the item refreshes this.
    queryKey: from === null ? ["item", itemId] : ["item", itemId, { from }],
    queryFn: () => ipcQuery("items:get", from === null ? { itemId } : { itemId, from }),
    // Holding the page is a new key. Until it answers, the page drawn is
    // the one it was held from — which starts at the very comment it was
    // held at — and never another item's.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === itemId ? previous : undefined),
  });

  // The comment the page was held at has gone: let go rather than draw a gap.
  const lost = from !== null && detail.data != null && !detail.isPlaceholderData && detail.data.comments[0]?.id !== from;
  const lostWith = lost ? detail.data : undefined;
  useEffect(() => {
    if (lostWith === undefined) return;
    // What told us is the newest page itself — `items:get` answers a
    // `from` it no longer holds as if there were none — so it is what the
    // unheld page shows, rather than whatever that key last cached, which
    // may still draw the comment that was deleted.
    queryClient.setQueryData(["item", itemId], lostWith);
    setHeld(null);
  }, [lostWith, queryClient, itemId]);
  const holding = from !== null && !lost;

  const history = useInfiniteQuery({
    queryKey: [...itemHistoryKey(itemId), from],
    enabled: holding,
    initialPageParam: from ?? "",
    queryFn: ({ pageParam }) => ipcQuery("items:earlierComments", { itemId, before: pageParam }),
    // Each page reads before the oldest of the one above it — recomputed
    // from the refetched page on every refresh, so a deletion leaves no gap.
    getNextPageParam: (last) => (last.earlier > 0 ? last.comments[0]?.id : undefined),
  });

  const pages = holding ? history.data?.pages : undefined;
  const newest = detail.data?.comments;
  const comments = useMemo(
    () =>
      mergedComments(
        // Nearest the page first as read; oldest first as drawn.
        [...(pages ?? [])].reverse().flatMap((page) => page.comments),
        newest ?? [],
      ),
    [pages, newest],
  );
  const oldestPage = pages?.at(-1);
  const remaining = oldestPage !== undefined ? oldestPage.earlier : (detail.data?.earlierComments ?? 0);
  const loading = holding && (history.isLoading || history.isFetchingNextPage);

  return {
    detail,
    comments,
    remaining,
    loading,
    problem: holding && history.error ? history.error.message : null,
    load: () => {
      if (loading) return;
      if (!holding) {
        const first = newest?.[0];
        if (first !== undefined) setHeld({ itemId, from: first.id });
        return;
      }
      if (history.data === undefined) void history.refetch();
      else if (history.hasNextPage) void history.fetchNextPage();
    },
    invalidateHistory: () => queryClient.invalidateQueries({ queryKey: itemHistoryKey(itemId) }),
  };
}
