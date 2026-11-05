import { useCallback, useState, type ReactNode, type Ref } from "react";
import { Virtuoso, type ContextProp, type ItemProps, type ListProps } from "react-virtuoso";

/**
 * A long list, drawn a screenful at a time (EO-565).
 *
 * The items list, the archive, the inbox and the open mentions can each
 * hold thousands of rows, and every one of them was mounted on every
 * render. This mounts the rows near the viewport and a margin either
 * side, through react-virtuoso — the library the transcript already
 * uses, so nothing new is installed.
 *
 * A view scrolls inside the canvas rather than in a box of its own, so
 * the list has no height to scroll in: it follows the nearest ancestor
 * that scrolls (the canvas's tab panel, or a popped-out window's page),
 * and the window where there is none. The markup is the `RowList`'s — a
 * labelled `<ul>` of `<li>`s — so a list reads the same to a screen
 * reader, and to a test, whichever draws it.
 */
export function VirtualRows<T>({
  label,
  data,
  rowKey,
  className,
  children,
}: {
  /** The list's accessible name. */
  label: string;
  data: readonly T[];
  /** A row's stable identity, so a row keeps its state as the list moves. */
  rowKey: (row: T) => string;
  /**
   * On the `<ul>`, in place of `RowList`'s rules between rows. Space
   * between rows goes on the rows, never as a `gap`: the list measures
   * its rows, and a gap is not in any of them.
   */
  className?: string;
  /** One row's content, inside its `<li>`. */
  children: (row: T, index: number) => ReactNode;
}) {
  // Undefined until the list is in the page and its scroller is known;
  // null where nothing above it scrolls.
  const [scroller, setScroller] = useState<HTMLElement | null | undefined>(undefined);
  const anchor = useCallback((node: HTMLDivElement | null) => {
    if (node !== null) setScroller(scrollingAncestorOf(node));
  }, []);
  const context: RowsContext = { label, className: className ?? ROW_RULES };
  return (
    <div ref={anchor} className="min-w-0">
      {scroller === undefined ? null : (
        <Virtuoso<T, RowsContext>
          data={data}
          context={context}
          components={ROWS}
          computeItemKey={(_index, row) => rowKey(row)}
          itemContent={(index, row) => children(row, index)}
          // A screen's worth either side, so a scroll does not show blanks.
          increaseViewportBy={600}
          {...(scroller === null ? { useWindowScroll: true } : { customScrollParent: scroller })}
        />
      )}
    </div>
  );
}

const ROW_RULES = "flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60";

interface RowsContext {
  label: string;
  className: string;
}

function RowsList({ context, children, style, ref, "data-testid": testId }: ListProps & ContextProp<RowsContext>) {
  return (
    <ul ref={ref as Ref<HTMLUListElement> | undefined} style={style} data-testid={testId} aria-label={context.label} className={context.className}>
      {children}
    </ul>
  );
}

function RowsItem({ item: _row, context: _context, children, ...rest }: ItemProps<unknown> & ContextProp<RowsContext>) {
  return <li {...rest}>{children}</li>;
}

// Module-level, so Virtuoso is handed the same components every render
// and never remounts the rows.
const ROWS = { List: RowsList, Item: RowsItem };

/** The nearest element above `node` that scrolls vertically, or null when only the window does. */
export function scrollingAncestorOf(node: HTMLElement): HTMLElement | null {
  for (let element = node.parentElement; element !== null; element = element.parentElement) {
    const { overflowY } = window.getComputedStyle(element);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return element;
  }
  return null;
}
