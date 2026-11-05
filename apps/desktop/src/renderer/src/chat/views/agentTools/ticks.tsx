import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@eo/ui";

/**
 * Two ticks the kit's `Checkbox` does not draw, shared by Agents and
 * Agent tools.
 *
 * `Checkbox` names its box by the words beside it and centres the two on
 * one line. These screens need the other two shapes: a tick whose name is
 * a sentence the eye does not read (`Reviewer gets github`, said on a row
 * of a dozen agents), and a tick beside a paragraph, which has to sit at
 * the paragraph's first line rather than its middle.
 *
 * A real `<input type="checkbox">` underneath both, so a `ReadOnlyFence`
 * (a `<fieldset disabled>`) reaches it without anybody passing a prop —
 * and `peer-disabled` dims the drawn box when it does.
 */

function Box({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border-[1.5px] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-focus peer-disabled:opacity-50",
        checked ? "border-accent bg-accent text-accent-ink" : "border-line-strong",
        className,
      )}
    >
      {checked ? <Check size={11} strokeWidth={3} /> : null}
    </span>
  );
}

/** A tick drawn as a chip, named by `label` rather than by what it shows. */
export function TickChip({
  checked,
  onChange,
  label,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The accessible name: the sentence the tick stands for. */
  label: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "inline-flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-[8px] px-2 text-[12.5px] has-[:disabled]:cursor-default",
        checked ? "bg-accent-subtle text-ink" : "bg-canvas-raised text-ink-muted hover:text-ink",
      )}
    >
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <Box checked={checked} />
      {children}
    </label>
  );
}

/**
 * A tick beside what it does, said in full.
 *
 * Named by its whole content — the sentence *is* the control's name,
 * because both halves of it (what ticking gives and what it costs) are
 * what a person is agreeing to — unless `label` says otherwise.
 */
export function TickOption({
  checked,
  onChange,
  label,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 cursor-pointer items-start gap-2.5 text-[12.5px] leading-relaxed text-ink-muted has-[:disabled]:cursor-default">
      <input
        type="checkbox"
        {...(label ? { "aria-label": label } : {})}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <Box checked={checked} className="mt-[3px]" />
      <span className="min-w-0">{children}</span>
    </label>
  );
}
