import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@eo/ui";

/**
 * The chat layout's surfaces: how a view is headed, how its content is
 * grouped, and the small marks it is annotated with. See `./controls` for
 * why these exist beside the design system's own.
 */

/**
 * The top of a view: what it is, a line about it, and its own actions.
 *
 * No breadcrumbs and no back or forward: a view is a tab beside the
 * conversation, and the tab row is the way between views.
 *
 * `stackActions` is for a head whose actions are wide — a pipeline's
 * switch between its views, and a button beside it (EO-409). Side by
 * side with those, in a canvas a few hundred pixels across, the title
 * was left a column one word wide. So such a head measures itself, and
 * until it is wide enough for both it puts the actions on a row of their
 * own under the title. It asks its own width rather than the window's
 * because the canvas is what is narrow: the conversation beside it
 * takes its share of any window.
 */
export function ViewHeader({
  title,
  meta,
  actions,
  icon,
  stackActions = false,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  /** Put the actions under the title while the head is too narrow to hold both on one row. */
  stackActions?: boolean;
  /** Under the title: a filter row, tabs. */
  children?: ReactNode;
}) {
  return (
    <header className={cn("mb-4 flex flex-col gap-3", stackActions && "@container/head")}>
      <div className={cn("flex min-w-0 gap-3", stackActions ? "flex-col @3xl/head:flex-row @3xl/head:items-start" : "items-start")}>
        {icon ? <span className="mt-[3px] grid h-7 w-7 shrink-0 place-items-center rounded-[9px] bg-canvas-raised text-ink-muted">{icon}</span> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Wraps rather than truncating: a long item title is read here or nowhere. */}
          <h1 className="break-words text-[17px] font-semibold leading-snug text-ink">{title}</h1>
          {meta ? <p className="text-[12.5px] leading-snug text-ink-subtle">{meta}</p> : null}
        </div>
        {actions ? (
          <div className={cn("flex flex-wrap items-center gap-1.5", stackActions ? "@3xl/head:shrink-0 @3xl/head:justify-end" : "shrink-0 justify-end")}>{actions}</div>
        ) : null}
      </div>
      {children}
    </header>
  );
}

/** The lit block a view's content sits in: the conversation's own ground, on the canvas's darker one. */
export function Card({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <section {...(label ? { "aria-label": label } : {})} className={cn("flex min-w-0 flex-col gap-3 rounded-[14px] bg-canvas px-[18px] py-4", className)}>
      {children}
    </section>
  );
}

/**
 * One titled part of a view: a heading, a line about it, its actions,
 * and its content — as a card, so a settings page reads as a stack of
 * things to look at rather than one long form.
 */
export function CardSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col gap-3 rounded-[14px] bg-canvas px-[18px] py-4", className)}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-[14px] font-medium text-ink">{title}</h2>
          {description ? <p className="text-[12.5px] leading-snug text-ink-subtle">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** The small spaced capitals over a group of rows: "WAITING ON YOU", "PIPELINES". */
export function GroupLabel({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-subtle">
      <span>{children}</span>
      {trailing !== undefined ? <span className="ml-auto font-sans normal-case tracking-normal">{trailing}</span> : null}
    </div>
  );
}

export type Tone = "neutral" | "accent" | "success" | "running" | "reviewing" | "paused" | "danger";

const CHIP_TONE: Record<Tone, string> = {
  neutral: "bg-canvas-raised text-ink-muted",
  accent: "bg-accent-subtle text-accent-soft",
  success: "bg-success/15 text-success",
  running: "bg-running/15 text-running",
  reviewing: "bg-reviewing/15 text-reviewing",
  paused: "bg-paused/15 text-paused",
  danger: "bg-danger/15 text-danger",
};

/** A short label on a row: a state, a type, a count with a word. */
export function Chip({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      {...(title ? { title } : {})}
      className={cn("inline-flex h-[22px] min-w-0 shrink-0 items-center gap-1 rounded-[7px] px-2 text-[11.5px] whitespace-nowrap", CHIP_TONE[tone], className)}
    >
      {children}
    </span>
  );
}

const DOT_TONE: Record<Exclude<Tone, "accent">, string> = {
  neutral: "bg-idle",
  success: "bg-success",
  running: "bg-running",
  reviewing: "bg-reviewing",
  paused: "bg-paused",
  danger: "bg-danger",
};

/** A status mark. Always with words beside it or a label on it: a colour alone says nothing to some people. */
export function StatusDot({ tone, label }: { tone: Exclude<Tone, "accent">; label?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center">
      <span aria-hidden className={cn("h-[7px] w-[7px] rounded-full", DOT_TONE[tone])} />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

/**
 * A row in a list: something to open, with what it is, a line under it,
 * and what is at its end. A link when it goes somewhere, a button when it
 * does something, plain otherwise.
 */
export function Row({
  leading,
  title,
  meta,
  trailing,
  to,
  onClick,
  selected,
  className,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  to?: string;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
}) {
  const body = (
    <>
      {leading ? <span className="flex shrink-0 items-center text-ink-subtle">{leading}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="truncate text-[13px] text-ink">{title}</span>
        {meta ? <span className="truncate text-[11.5px] text-ink-subtle">{meta}</span> : null}
      </span>
      {trailing ? <span className="flex shrink-0 items-center gap-1.5">{trailing}</span> : null}
      {to ? <ChevronRight aria-hidden size={14} className="shrink-0 text-ink-subtle" /> : null}
    </>
  );
  const shape = cn(
    "flex min-h-11 w-full min-w-0 items-center gap-3 rounded-[10px] px-3 py-2",
    (to || onClick) && "hover:bg-canvas-raised",
    selected && "bg-canvas-raised",
    className,
  );
  if (to) {
    return (
      <Link to={to} className={shape} {...(selected ? { "aria-current": "page" as const } : {})}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={shape} {...(selected !== undefined ? { "aria-pressed": selected } : {})}>
        {body}
      </button>
    );
  }
  return <div className={shape}>{body}</div>;
}

/** A list of rows, with the hairline between them. */
export function RowList({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <ul aria-label={label} className={cn("flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60", className)}>
      {children}
    </ul>
  );
}

/** What a view says when there is nothing in it yet, and the way to put something there. */
export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-[14px] border border-dashed border-line px-[18px] py-5">
      <p className="text-[13.5px] font-medium text-ink">{title}</p>
      {children ? <div className="text-[12.5px] leading-relaxed text-ink-subtle">{children}</div> : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

const NOTICE_TONE = {
  info: "bg-accent-subtle/60 text-ink-muted",
  paused: "bg-paused/15 text-ink",
  danger: "bg-danger/12 text-ink",
} as const;

/** A sentence the view needs read before the rest: a lock, a warning, a failure. */
export function Notice({
  tone = "info",
  title,
  children,
  action,
  role,
}: {
  tone?: keyof typeof NOTICE_TONE;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div {...(role ? { role } : {})} className={cn("flex items-start gap-3 rounded-[12px] px-3.5 py-2.5 text-[12.5px] leading-relaxed", NOTICE_TONE[tone])}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title ? <span className={cn("font-medium", tone === "paused" ? "text-paused" : tone === "danger" ? "text-danger" : "text-ink")}>{title}</span> : null}
        {children}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Name and value pairs: a definition list in two columns. */
export function Facts({ items, label }: { items: readonly { term: ReactNode; value: ReactNode }[]; label?: string }) {
  return (
    <dl {...(label ? { "aria-label": label } : {})} className="m-0 grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12.5px]">
      {items.map((item, index) => (
        <div key={index} className="contents">
          <dt className="text-ink-subtle">{item.term}</dt>
          <dd className="m-0 min-w-0 break-words text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * While something loads: a quiet line, never a spinner over the whole
 * view. Polite rather than a `status` region, so a view's own status line
 * — a warning, a result — is the one status on it.
 */
export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <p aria-live="polite" aria-busy="true" className="text-[12.5px] text-ink-subtle">
      {children}
    </p>
  );
}

/** An error from the main process, said plainly where the thing that failed is. */
export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-[12.5px] text-danger">
      {children}
    </p>
  );
}

/** Two-column view body: a list on the left and the open thing on the right. */
export function SplitView({ list, children, listLabel, listWidth = "w-[17rem]" }: { list: ReactNode; children: ReactNode; listLabel: string; listWidth?: string }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-4">
      <nav aria-label={listLabel} className={cn("flex shrink-0 flex-col gap-0.5 overflow-y-auto relative", listWidth)}>
        {list}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-4">{children}</div>
    </div>
  );
}

/** One entry in a `SplitView` list or a settings nav. */
export function NavItem({ children, selected, onClick, trailing }: { children: ReactNode; selected: boolean; onClick: () => void; trailing?: ReactNode }) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-2 rounded-[10px] px-3 text-left text-[13px]",
        selected ? "bg-canvas-raised text-ink" : "text-ink-muted hover:bg-canvas-subtle hover:text-ink",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}
