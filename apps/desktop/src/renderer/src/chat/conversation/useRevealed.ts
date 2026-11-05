import { useEffect, useRef, useState } from "react";

/** How long a backlog takes to drain, whatever its size: a quarter second behind the model at most. */
const CATCH_UP_MS = 250;

/**
 * Text being written, revealed at a steady pace rather than in the lumps it
 * arrives in.
 *
 * A backend sends a block's words in pieces of very different sizes — a
 * token at a time for a message, a sentence at a time for the answer a
 * structured-output tool is writing — and drawn as they land, a reply
 * lurches. Claude Desktop paces its reveal; this does the same: each frame
 * shows a share of what has arrived and is not yet shown, sized so that
 * any backlog is drained in about a quarter of a second. The reveal never
 * runs ahead of the text and never holds back text that arrived long ago.
 *
 * Shown at once where a person asked for reduced motion, and whenever the
 * text is not a prefix-extension of what was shown (a new draft, or the
 * view's copy replacing a shorter one), so nothing is ever animated
 * backwards.
 */
export function useRevealed(text: string, fromStart = false): string {
  const reduced = useReducedMotion();
  // What is already there when it is first drawn — a window opened
  // mid-answer — is shown at once; only what arrives after is paced. A
  // block that begins while the turn is already on screen (`fromStart`)
  // is paced from its first word, however large the piece it arrived in:
  // a backend that sends a paragraph at once still reads as writing.
  const [shown, setShown] = useState(fromStart ? "" : text);
  const target = useRef(text);
  target.current = text;

  useEffect(() => {
    if (reduced || !text.startsWith(shown)) {
      setShown(text);
      return undefined;
    }
    if (shown.length >= text.length) return undefined;
    let frame = 0;
    let last = performance.now();
    const step = (now: number): void => {
      const elapsed = Math.max(1, now - last);
      last = now;
      setShown((current) => {
        const goal = target.current;
        if (!goal.startsWith(current)) return goal;
        const backlog = goal.length - current.length;
        if (backlog <= 0) return current;
        const share = Math.max(1, Math.ceil((backlog * elapsed) / CATCH_UP_MS));
        return goal.slice(0, current.length + share);
      });
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text, shown, reduced]);

  return reduced ? text : shown;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = (): void => setReduced(query.matches);
    query.addEventListener?.("change", change);
    return () => query.removeEventListener?.("change", change);
  }, []);
  return reduced;
}
