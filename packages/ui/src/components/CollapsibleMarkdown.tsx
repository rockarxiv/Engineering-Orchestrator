import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../cn.js";
import { Markdown } from "./Markdown.js";

/**
 * A rendered body taller than this starts collapsed (EO-419).
 *
 * About fourteen lines of the 16px / 1.6 reading text. Measured on what
 * was drawn, never on characters or lines: a two-line comment holding a
 * forty-row table is long.
 */
export const COLLAPSE_ABOVE_PX = 360;

/**
 * What a collapsed body is clipped to — about ten lines.
 *
 * Deliberately well under the threshold: with the two equal, the toggle
 * would sometimes hide a single line, which costs a click to read and
 * saves nothing.
 */
export const COLLAPSED_HEIGHT_PX = 256;

/** How much of the clipped body's foot dissolves, so the cut reads as "more below" and not as the end. */
const FADE_PX = 56;

export interface CollapsibleMarkdownProps {
  children: string;
  className?: string | undefined;
  /**
   * Dresses the toggle in the layout it is drawn in. The two item screens
   * share the rule — the numbers, the state, what the control is — and
   * not a look: the chat layout takes no control styling from here.
   */
  toggleClassName?: string | undefined;
}

/**
 * Markdown that clips itself when it runs long, with a Show more / Show
 * less toggle beneath it (EO-419).
 *
 * Whether it is expanded lives here and nowhere else: it survives a
 * re-render of the same row, goes with the row when the reader leaves,
 * and is never persisted. Every long body starts collapsed.
 *
 * ### Why the toggle is not a `<button>`
 *
 * This is drawn inside a `<fieldset disabled>` for a reader who may only
 * read (the item screens' `ReadOnlyFence`), and a fieldset disables every
 * real form control within it. Expanding a comment is reading, so a
 * `<button>` here would be dead for exactly the person with nothing else
 * they can do. A `role="button"` element is not a form control, so the
 * fence leaves it alone while still closing Pin and Delete beside it; the
 * keyboard handling a `<button>` gives for free is written out below.
 * That is safe only because this control changes nothing but what is on
 * screen — anything that mutates stays a `<button>`.
 */
export function CollapsibleMarkdown({ children, className, toggleClassName }: CollapsibleMarkdownProps) {
  const body = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Before paint, so a long body is never seen at full height first. The
  // clip is a max-height, and `scrollHeight` reports the content's height
  // through it, so the measurement is the same collapsed or not.
  useLayoutEffect(() => {
    if (body.current) setLong(body.current.scrollHeight > COLLAPSE_ABOVE_PX);
  }, [children]);

  if (!long) {
    return (
      <div ref={body} className={className}>
        <Markdown>{children}</Markdown>
      </div>
    );
  }

  const collapsed = !expanded;
  const toggle = () => setExpanded((was) => !was);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    // Space would otherwise scroll the page.
    event.preventDefault();
    toggle();
  }

  const fade = `linear-gradient(to bottom, black calc(100% - ${FADE_PX}px), transparent)`;

  return (
    <div className={className}>
      <div
        ref={body}
        id={bodyId}
        data-collapsed={collapsed}
        className={cn(collapsed && "overflow-hidden")}
        // A mask rather than a gradient laid over the text: the rows this
        // sits in have different backgrounds, and a mask fades to whatever
        // is behind it.
        style={collapsed ? { maxHeight: COLLAPSED_HEIGHT_PX, maskImage: fade, WebkitMaskImage: fade } : undefined}
      >
        <Markdown>{children}</Markdown>
      </div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={toggle}
        onKeyDown={onKeyDown}
        className={cn(
          "mt-1 inline-flex h-6 cursor-pointer select-none items-center rounded-md text-xs font-medium text-ink-muted hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          toggleClassName,
        )}
      >
        {expanded ? "Show less" : "Show more"}
      </div>
    </div>
  );
}
