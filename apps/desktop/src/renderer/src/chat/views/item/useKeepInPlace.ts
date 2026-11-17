import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

/** The attribute every drawn comment carries its id in, a reply as much as a top-level comment. */
export const COMMENT_ID_ATTRIBUTE = "data-comment-id";

/**
 * Keeps what a person is reading where it is on screen while comments are
 * read back above it (EO-823).
 *
 * "Show earlier comments" inserts older comments above the oldest one
 * drawn. Left alone, everything already on screen is pushed down by
 * however tall they are. The browser's own scroll anchoring cannot be
 * counted on to stop it: the element it anchors to may be the control
 * itself, which sits above what is inserted and does not move.
 *
 * So the press holds the comment at the top of the viewport — by its id,
 * not its element — and where it stood. Every render until the read back
 * has landed finds that comment again, measures where it stands now and
 * scrolls the scroller by the difference, before the browser paints.
 *
 * By id because what is read back can move the comments already drawn,
 * not only push them down: a reply whose parent was outside the window
 * was drawn at the top level, and once the parent is read back it is
 * drawn again under it, a new element somewhere else (`buildTimeline`).
 * Measured rather than computed, the correction is right whoever moved
 * it: where the browser has already anchored, the difference is nothing.
 *
 * Let go once the comments above it have been drawn — their first one is
 * no longer the one that was first at the press — or the read has ended
 * without any (`loading` came and went), or the comment is gone. Held
 * past that, the next render would scroll the person back from wherever
 * they had scrolled to.
 */
export function useKeepInPlace({
  thread,
  loading,
  firstId,
}: {
  /** What the comments are drawn in, each marked with `COMMENT_ID_ATTRIBUTE`. */
  thread: RefObject<Element | null>;
  loading: boolean;
  firstId: string | undefined;
}): () => void {
  const held = useRef<{ commentId: string; top: number; scroller: Element; firstId: string | undefined; sawLoading: boolean } | null>(null);

  useLayoutEffect(() => {
    const hold = held.current;
    if (hold === null) return;
    const element = thread.current === null ? undefined : commentsIn(thread.current).find((comment) => comment.getAttribute(COMMENT_ID_ATTRIBUTE) === hold.commentId);
    if (element === undefined) {
      held.current = null;
      return;
    }
    const moved = element.getBoundingClientRect().top - hold.top;
    if (moved !== 0) hold.scroller.scrollTop += moved;
    if (loading) hold.sawLoading = true;
    if (firstId !== hold.firstId || (hold.sawLoading && !loading)) held.current = null;
  });

  return useCallback(() => {
    held.current = null;
    if (thread.current === null) return;
    const comments = commentsIn(thread.current);
    const scroller = scrollerOf(thread.current);
    if (comments.length === 0 || scroller === null) return;
    // The first comment reaching into the viewport; the last drawn where the thread is all above it.
    const viewportTop = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    const reading = comments.find((comment) => comment.getBoundingClientRect().bottom > viewportTop) ?? comments.at(-1)!;
    const commentId = reading.getAttribute(COMMENT_ID_ATTRIBUTE);
    if (commentId === null) return;
    held.current = { commentId, top: reading.getBoundingClientRect().top, scroller, firstId, sawLoading: false };
  }, [thread, firstId]);
}

function commentsIn(thread: Element): Element[] {
  return [...thread.querySelectorAll(`[${COMMENT_ID_ATTRIBUTE}]`)];
}

/** The nearest ancestor that scrolls, or the document's own scroller. */
function scrollerOf(element: Element): Element | null {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return at;
  }
  return document.scrollingElement;
}
