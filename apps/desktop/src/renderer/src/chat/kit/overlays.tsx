import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@eo/ui";
import { Button, IconButton } from "./controls";

/**
 * Dialogs and menus for the chat layout.
 *
 * Drawn here rather than borrowed from `@eo/ui` for `./controls`' reason,
 * and portalled to the document so a dialog opened from a narrow canvas
 * covers the window rather than the column it was opened in.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog: the scrim, a panel, a title the dialog is named by,
 * Escape and the scrim to close it, focus moved in on open, kept in
 * while open, and handed back to whatever opened it on close.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "w-[28rem]",
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
  /** While the dialog's action is in flight: Escape, the scrim and the X stop closing it, so a result is never shown to nobody. */
  busy?: boolean;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = busy ? () => undefined : onClose;

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus]") ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) return;
      const head = focusable[0]!;
      const tail = focusable[focusable.length - 1]!;
      // Focus that fell out of the dialog — the control it was on went away
      // when the dialog changed under it — comes back in, never behind the scrim.
      if (!panel.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? tail : head).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      before?.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] grid place-items-center p-6">
      <div aria-hidden className="absolute inset-0 bg-scrim" onClick={() => close.current()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        {...(description ? { "aria-describedby": `${id}-description` } : {})}
        tabIndex={-1}
        className={cn("relative flex max-h-full max-w-full flex-col gap-4 overflow-hidden rounded-[16px] bg-canvas-subtle p-5 shadow-panel", width)}
      >
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 id={`${id}-title`} className="text-[15px] font-semibold text-ink">
              {title}
            </h2>
            {description ? (
              <p id={`${id}-description`} className="text-[12.5px] leading-relaxed text-ink-subtle">
                {description}
              </p>
            ) : null}
          </div>
          {/* "Close dialog" rather than "Close": a dialog's own footer often has a Close of its own. */}
          <IconButton label="Close dialog" icon={<X size={15} />} disabled={busy} onClick={() => close.current()} className="-mr-1.5 -mt-1" />
        </div>
        {children ? <div className="min-h-0 overflow-y-auto relative">{children}</div> : null}
        {footer ? <div className="flex flex-wrap items-center justify-end gap-2">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * "Are you sure?", with the consequence in words and the action named on
 * its button — never "OK". `tone="danger"` for what cannot be undone.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "primary",
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  /** What the way out is called, when "Cancel" would not say what is kept. */
  cancelLabel?: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      busy={busy}
      footer={
        <>
          {/* What cannot be undone is never one Enter away: a dangerous confirmation opens on Cancel. */}
          <Button variant="ghost" disabled={busy} onClick={onCancel} {...(tone === "danger" ? { "data-autofocus": true } : {})}>
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} disabled={busy} onClick={onConfirm} {...(tone === "danger" ? {} : { "data-autofocus": true })}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink-muted">
        {children}
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export interface MenuEntry {
  label: string;
  onSelect: () => void;
  tone?: "plain" | "danger";
  disabled?: boolean;
}

/**
 * A button that opens a short menu of commands. Escape and a click away
 * close it; each entry is a `menuitem`.
 */
export function Menu({
  label,
  trigger,
  entries,
  align = "right",
}: {
  /** What the button and the menu are called. */
  label: string;
  /** What the button shows. */
  trigger: ReactNode;
  entries: readonly MenuEntry[];
  align?: "left" | "right";
}) {
  const [at, setAt] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const open = at !== null;
  const close = (returnFocus: boolean) => {
    setAt(null);
    if (returnFocus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    // Opened, the first command has focus, so the keyboard is in the menu
    // rather than at the end of the page the menu is portalled to.
    list.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    // A menu stays where it opened; anything that moves its button closes it.
    const onMove = (event: Event) => {
      if (list.current && event.target instanceof Node && list.current.contains(event.target)) return;
      setAt(null);
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);
  const toggle = () => {
    if (open) {
      close(false);
      return;
    }
    const rect = button.current?.getBoundingClientRect();
    const top = (rect?.bottom ?? 0) + 4;
    setAt(align === "right" ? { top, right: window.innerWidth - (rect?.right ?? 0) } : { top, left: rect?.left ?? 0 });
  };
  return (
    <span className="relative inline-flex">
      <button
        ref={button}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className="grid h-[30px] min-w-[30px] place-items-center rounded-[10px] px-1 text-ink-subtle hover:bg-canvas-raised hover:text-ink"
      >
        {trigger}
      </button>
      {at ? <MenuList list={list} label={label} entries={entries} at={at} onClose={close} /> : null}
    </span>
  );
}

/**
 * The list a menu opens: the click-away catcher and the commands, in a
 * portal so a list that scrolls on its own never clips the menu of one
 * of its rows. Shared by `Menu` and `ContextMenu`, which differ only in
 * what opens them and where.
 */
function MenuList({
  list,
  label,
  entries,
  at,
  onClose,
}: {
  list: RefObject<HTMLDivElement | null>;
  label: string;
  entries: readonly MenuEntry[];
  at: { top: number; left?: number; right?: number };
  /** `returnFocus` is false only for a click away from a menu whose opener says so. */
  onClose: (returnFocus: boolean) => void;
}) {
  /** Arrows and Home/End move between commands; Escape and Tab leave the menu, back on what opened it. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      onClose(true);
    }
  };
  return createPortal(
    <>
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={() => onClose(false)}
        // A second right-click away from the menu closes it too, rather than opening the system's menu over it.
        onContextMenu={(event) => {
          event.preventDefault();
          onClose(false);
        }}
        className="fixed inset-0 z-[var(--z-dropdown)] cursor-default"
      />
      <div
        ref={list}
        role="menu"
        aria-label={label}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => event.preventDefault()}
        style={{ top: at.top, ...(at.left !== undefined ? { left: at.left } : { right: at.right }) }}
        className="fixed z-[calc(var(--z-dropdown)+1)] flex w-[13rem] flex-col gap-px rounded-[14px] bg-canvas-raised p-1.5 shadow-panel"
      >
        {entries.map((entry) => (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={entry.disabled}
            onClick={() => {
              onClose(true);
              entry.onSelect();
            }}
            className={cn(
              "flex w-full rounded-lg px-2 py-1.5 text-left text-[13px] focus:outline-none disabled:opacity-50",
              entry.tone === "danger" ? "text-danger hover:bg-danger/15 focus:bg-danger/15" : "text-ink-muted hover:bg-canvas-hover hover:text-ink focus:bg-canvas-hover focus:text-ink",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

/** The menu's width (`w-[13rem]`) and the gap kept from the window's edge, for placing one at a point. */
const MENU_WIDTH = 208;
const MENU_EDGE = 8;
/** One command's height and the list's own padding, for the same sum from the bottom edge. */
const MENU_ROW = 31;
const MENU_PADDING = 12;

/** Where a context menu opens: the pointer, or the row it was asked for from the keyboard. */
export interface ContextMenuAt {
  x: number;
  y: number;
  /** What the menu is about, and where focus goes back to when it closes. */
  anchor: HTMLElement;
}

/**
 * Where to open a context menu for `event`'s element: at the pointer for
 * a right-click, and just inside the element when the event carries no
 * point — the context-menu key and Shift+F10, which have no pointer.
 */
export function contextMenuAt(anchor: HTMLElement, point?: { clientX: number; clientY: number }): ContextMenuAt {
  if (point && (point.clientX !== 0 || point.clientY !== 0)) return { x: point.clientX, y: point.clientY, anchor };
  const rect = anchor.getBoundingClientRect();
  return { x: rect.left + 16, y: rect.bottom - 4, anchor };
}

/** Is this the keyboard asking for a context menu? The context-menu key, or Shift+F10. */
export function isContextMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

/**
 * A menu of commands about one thing, opened where it was asked for
 * rather than under a button of its own: `Menu`'s list at a point.
 *
 * The opener holds `at` — set from the thing's `onContextMenu`, and from
 * its `onKeyDown` when `isContextMenuKey`, so the menu is reachable
 * without a pointer. Escape, Tab, a click away and choosing a command
 * all close it, and all hand focus back to `at.anchor`: a menu with no
 * button has nowhere else to leave the keyboard.
 */
export function ContextMenu({ label, at, entries, onClose }: { label: string; at: ContextMenuAt | null; entries: readonly MenuEntry[]; onClose: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const open = at !== null;
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    // A menu stays where it opened; anything that moves what it is about closes it.
    const onMove = (event: Event) => {
      if (list.current && event.target instanceof Node && list.current.contains(event.target)) return;
      close.current();
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);
  if (!at) return null;
  // Kept inside the window: a row at the right or bottom edge still gets a whole menu.
  const height = entries.length * MENU_ROW + MENU_PADDING;
  const left = Math.max(MENU_EDGE, Math.min(at.x, window.innerWidth - MENU_WIDTH - MENU_EDGE));
  const top = Math.max(MENU_EDGE, Math.min(at.y, window.innerHeight - height - MENU_EDGE));
  return (
    <MenuList
      list={list}
      label={label}
      entries={entries}
      at={{ top, left }}
      onClose={() => {
        onClose();
        at.anchor.focus();
      }}
    />
  );
}
