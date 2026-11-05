import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** How close to the end still counts as "at the end": a line and a bit. */
export const NEAR_BOTTOM_PX = 80;

/**
 * Follows the newest words while a person is reading the newest words, and
 * leaves them alone once they have scrolled up — Claude Desktop's
 * transcript, and the fix for a chat that yanked somebody back to the
 * bottom every time a token arrived.
 *
 * "Following" is decided by where the person put the scroller, not by
 * what arrived: it starts on, turns off the moment they move up — a
 * wheel, a touch drag, a key — and turns back on when they scroll back to
 * the end or press "Jump to latest". Growth is watched with a
 * ResizeObserver on the content rather than on a list of dependencies,
 * because a draft growing by a word, a fold opening and an image loading
 * all move the end and none of them is a message arriving.
 *
 * Its own scrolls are told from the person's by where they leave the
 * scroller, not by when they happen: a person's wheel during a burst of
 * growth lands in the same frame as the hook's own scroll, and a timing
 * flag would swallow it.
 *
 * `resetKey` puts it back to following — a different chat, or the column
 * coming back from being folded, which loses its offset.
 */
export function useStickToBottom(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  resetKey: unknown,
): { following: boolean; jumpToLatest: () => void } {
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  /** Where this hook last put the scroller; a scroll that leaves it there was the hook's. */
  const placedAt = useRef<number | null>(null);

  const setFollow = useCallback((value: boolean) => {
    if (followingRef.current === value) return;
    followingRef.current = value;
    setFollowing(value);
  }, []);

  const toBottom = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const end = Math.max(0, element.scrollHeight - element.clientHeight);
    if (Math.abs(element.scrollTop - end) < 1) return;
    element.scrollTop = end;
    placedAt.current = element.scrollTop;
  }, [scroller]);

  useLayoutEffect(() => {
    followingRef.current = true;
    setFollowing(true);
    toBottom();
  }, [resetKey, toBottom]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const onScroll = (): void => {
      if (placedAt.current !== null && Math.abs(element.scrollTop - placedAt.current) < 2) return;
      placedAt.current = null;
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      setFollow(distance <= NEAR_BOTTOM_PX);
    };
    // Moving up stops following at once, before any scroll event: the
    // content may grow in the same frame and would pull the view back.
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) setFollow(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") setFollow(false);
    };
    const onTouch = (): void => setFollow(false);
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("keydown", onKey);
    element.addEventListener("touchmove", onTouch, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("touchmove", onTouch);
    };
  }, [scroller, setFollow]);

  useEffect(() => {
    const inner = content.current;
    if (!inner || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) toBottom();
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [content, toBottom]);

  const jumpToLatest = useCallback(() => {
    setFollow(true);
    toBottom();
  }, [setFollow, toBottom]);

  return { following, jumpToLatest };
}
