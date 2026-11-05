import { useCallback, useRef, useState } from "react";

/** Where a post goes: under the comment it answers, or onto the thread itself (`null`). */
export type PostTarget = string | null;

/**
 * Every comment on its way from the item page, by where it goes (EO-565).
 *
 * One `comments:post` mutation sends every reply and every comment on
 * the page, and its `isPending` and `variables` describe only the latest
 * call: reply to one question, then another before the first lands, and
 * the first would be drawn as settled — its answers pressable again —
 * while its post is still on the wire. So each post is held here from
 * the press until it settles, success or failure, keyed by its target:
 *
 * - `pending` says which threads are sending, for each thread's box and
 *   for the page's own box, which is busy while any post is.
 * - `send` marks its target synchronously, so a second press on a thread
 *   already sending — a double click, or another offered answer pressed
 *   a render before the buttons are disabled — sends nothing. It is
 *   handed the post already in flight, and so is answered exactly as the
 *   first press is: no second answer is posted, and no box is cleared
 *   before its post has landed.
 */
export function useOutstandingPosts() {
  const inFlight = useRef(new Map<PostTarget, Promise<unknown>>());
  const [pending, setPending] = useState<ReadonlySet<PostTarget>>(() => new Set());

  const send = useCallback(<R>(target: PostTarget, post: () => Promise<R>): Promise<R> => {
    const already = inFlight.current.get(target);
    if (already !== undefined) return already as Promise<R>;
    const sending = post().finally(() => {
      inFlight.current.delete(target);
      setPending(new Set(inFlight.current.keys()));
    });
    inFlight.current.set(target, sending);
    setPending(new Set(inFlight.current.keys()));
    return sending;
  }, []);

  return { pending, send };
}
