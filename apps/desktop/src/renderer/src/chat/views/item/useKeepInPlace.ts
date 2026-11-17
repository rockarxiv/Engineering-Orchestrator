import { useCallback, useLayoutEffect, useRef } from "react";

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
 * So the press holds an element — the oldest entry drawn — and where it
 * stood; every render until the read back has landed measures where it
 * stands now and scrolls its scroller by the difference, before the
 * browser paints. Everything below that element, the one at the top of
 * the viewport included, stays where it was. Measured rather than
 * computed, the correction is right whoever else moved it: where the
 * browser has already anchored, the difference is nothing.
 *
 * Let go once the comments above it have been drawn — their first one is
 * no longer the one that was first at the press — or the read has ended
 * without any (`loading` came and went), or the element is gone. Held
 * past that, the next render would scroll the person back from wherever
 * they had scrolled to.
 */
export function useKeepInPlace({ loading, firstId }: { loading: boolean; firstId: string | undefined }): (element: Element | null | undefined) => void {
  const held = useRef<{ element: Element; top: number; firstId: string | undefined; sawLoading: boolean } | null>(null);

  useLayoutEffect(() => {
    const hold = held.current;
    if (hold === null) return;
    if (!hold.element.isConnected) {
      held.current = null;
      return;
    }
    const moved = hold.element.getBoundingClientRect().top - hold.top;
    if (moved !== 0) {
      const scroller = scrollerOf(hold.element);
      if (scroller !== null) scroller.scrollTop += moved;
    }
    if (loading) hold.sawLoading = true;
    if (firstId !== hold.firstId || (hold.sawLoading && !loading)) held.current = null;
  });

  return useCallback(
    (element) => {
      held.current = element == null ? null : { element, top: element.getBoundingClientRect().top, firstId, sawLoading: false };
    },
    [firstId],
  );
}

/** The nearest ancestor that scrolls, or the document's own scroller. */
function scrollerOf(element: Element): Element | null {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return at;
  }
  return document.scrollingElement;
}
