import { useEffect, useRef } from "react";
import { PictureInPicture2, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "@eo/ui";
import { IconButton } from "./kit";
import { DEEP } from "./parts";
import { ViewBody, ViewLabel, tabKeyOf, type ChatView } from "./views/registry";

/**
 * The canvas: whatever the conversation is about, drawn beside it
 * (ARCHITECTURE.md, "The chat-centric layout") — a board, an item,
 * Settings, an agent. Every place in the app is a view here
 * (`views/registry.tsx`); none is a classic screen.
 *
 * A row of tabs, one per thing opened this session, and the open view
 * under it.
 */

export interface CanvasTab {
  /** Which tab (`tabKeyOf`): a pipeline's board and its editor share one. */
  key: string;
  /** Where the tab was last, to go back to. */
  path: string;
  view: ChatView;
}

export function ChatCanvas({
  view,
  tabKey,
  tabs,
  onCloseTab,
  onClose,
  pop,
}: {
  view: ChatView;
  tabKey: string;
  tabs: readonly CanvasTab[];
  /** Forget one tab; closing the open one moves to the tab before it, or to the conversation. */
  onCloseTab: (key: string) => void;
  /** "Close the canvas": back to the conversation alone. */
  onClose: () => void;
  /**
   * Moving the canvas between the main window and one of its own
   * (EO-383): "Pop out" beside the conversation, "Pop in" in its own
   * window. Absent where EO cannot open a window — a browser served this
   * renderer — and no button is drawn there.
   */
  pop?: { label: "Pop out" | "Pop in"; onPress: () => void } | undefined;
}) {
  const navigate = useNavigate();
  // The open view's tab is always in sight, however many are open beside
  // a narrow canvas: the row scrolls to it rather than leaving it past the edge.
  const active = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    active.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tabKey]);
  return (
    <section aria-label="Canvas" className={cn("grid min-h-0 min-w-0 flex-1 grid-rows-[52px_minmax(0,1fr)] border-l border-line", DEEP)}>
      <div className="flex min-w-0 items-center gap-1 border-b border-line px-3">
        <div role="tablist" aria-label="Open views" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => {
            const on = tab.key === tabKey;
            return (
              // The tab and its own close, side by side: a button inside a tab
              // would be one control inside another. Only tabs belong in a
              // tablist, so the close is the pointer's; the keyboard closes
              // the focused tab with Delete.
              <span
                key={tab.key}
                role="presentation"
                className={cn(
                  "group/tab inline-flex h-8 max-w-[14rem] shrink-0 items-center rounded-[10px]",
                  on ? "bg-canvas-raised text-ink" : "text-ink-subtle hover:bg-canvas-subtle hover:text-ink-muted",
                )}
              >
                <button
                  ref={on ? active : undefined}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-keyshortcuts="Delete"
                  onClick={() => void navigate(tab.path)}
                  onKeyDown={(event) => {
                    if (event.key !== "Delete" && event.key !== "Backspace") return;
                    event.preventDefault();
                    onCloseTab(tab.key);
                  }}
                  className="inline-flex h-full min-w-0 items-center gap-[7px] pl-3 pr-1 text-[12.5px]"
                >
                  <ViewLabel view={tab.view} />
                </button>
                <button
                  type="button"
                  aria-hidden
                  tabIndex={-1}
                  title="Close this tab"
                  onClick={() => onCloseTab(tab.key)}
                  className={cn(
                    "mr-1 grid h-5 w-5 shrink-0 place-items-center rounded-[6px] text-ink-subtle hover:bg-canvas-hover hover:text-ink",
                    on ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
                  )}
                >
                  <X size={12} />
                </button>
              </span>
            );
          })}
        </div>
        {pop ? <IconButton label={pop.label} icon={<PictureInPicture2 size={16} />} onClick={pop.onPress} /> : null}
        <IconButton label="Close the canvas" icon={<X size={16} />} onClick={onClose} />
      </div>
      {/* Keyed on the tab and the kind of view in it, so moving between two
          items is a new view rather than the old one reused — a reason
          half-typed on one item's "Send back" must never be submitted
          against the next — while one view whose address moves under it
          (a Settings section, a board narrowed to a step) stays the one
          mount and keeps what it holds. */}
      <div key={mountKeyOf(view)} role="tabpanel" aria-label="Open view" className="flex min-h-0 min-w-0 flex-col overflow-auto px-[18px] relative py-4">
        <ViewBody view={view} />
      </div>
    </section>
  );
}

/**
 * When the canvas draws a view afresh: a new tab, or a new kind of view in
 * the same tab. Two items are two tabs, so two mounts — a reason half-typed
 * on one item's "Send back" is never submitted against the next. One view
 * whose address moves under it (a Settings section, a board narrowed to a
 * step) is one mount, and keeps what it holds.
 */
export function mountKeyOf(view: ChatView): string {
  return `${tabKeyOf(view)}|${view.kind}`;
}

/** The chip in the conversation's header naming what is open beside it. */
export function CanvasChip({ view }: { view: ChatView }) {
  return (
    <span className="inline-flex h-6 min-w-0 max-w-[14rem] items-center gap-[5px] rounded-[10px] bg-canvas-raised px-[9px] text-xs text-ink-muted">
      <ViewLabel view={view} />
    </span>
  );
}
