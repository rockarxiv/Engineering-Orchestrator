import { cloneElement, forwardRef, isValidElement, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@eo/ui";

/**
 * The chat layout's controls (ARCHITECTURE.md, "The chat-centric layout").
 *
 * Every screen the chat layout draws is built from these and from
 * `./surfaces`, never from the classic screens' components or the
 * design-system primitives in `@eo/ui`: the layout is a different
 * arrangement with its own density — 13px text, 10px radii, controls
 * that sit on the lit middle rather than in bordered boxes — and a screen
 * built from the other set looks borrowed, because it is.
 *
 * The tokens are the design system's, so a theme (`../theme.ts`) reaches
 * every one of them without a line here changing.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink hover:bg-accent-hover",
  secondary: "bg-canvas-raised text-ink hover:bg-canvas-hover",
  ghost: "text-ink-muted hover:bg-canvas-raised hover:text-ink",
  danger: "bg-danger/15 text-danger hover:bg-danger/25",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  md: "h-8 gap-1.5 px-3 text-[12.5px]",
  sm: "h-[26px] gap-1 px-2.5 text-xs",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** An icon before the label, sized for the button. */
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, className, children, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[10px] font-medium whitespace-nowrap disabled:pointer-events-none disabled:opacity-50",
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
});

/** A link drawn as a button: for an action that is a place — "Configure", "Open the archive". */
export function LinkButton({
  to,
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  ...props
}: Omit<LinkProps, "className"> & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode; className?: string }) {
  return (
    <Link
      to={to}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-[10px] font-medium whitespace-nowrap", BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
      {...props}
    >
      {icon}
      {children}
    </Link>
  );
}

/** A square button that is only an icon: the label is what a screen reader and a tooltip say. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { label: string; icon: ReactNode; tone?: "plain" | "danger" }
>(function IconButton({ label, icon, tone = "plain", className, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[10px] disabled:pointer-events-none disabled:opacity-50",
        tone === "danger" ? "text-ink-subtle hover:bg-danger/15 hover:text-danger" : "text-ink-subtle hover:bg-canvas-raised hover:text-ink",
        className,
      )}
      {...props}
    >
      {icon}
    </button>
  );
});

const FIELD_SURFACE =
  "w-full min-w-0 rounded-[10px] border border-transparent bg-canvas-raised text-[13px] text-ink placeholder:text-ink-subtle hover:border-line focus:border-line-strong focus:outline-none disabled:opacity-60";

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...props }, ref) {
  return <input ref={ref} className={cn(FIELD_SURFACE, "h-8 px-2.5", className)} {...props} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(FIELD_SURFACE, "min-h-20 px-2.5 py-2 leading-relaxed", className)} {...props} />;
});

/** A native select, drawn as the other fields are. Native so the keyboard and the platform's list behave as people expect. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return (
    <span className={cn("relative inline-flex w-full min-w-0", className)}>
      <select ref={ref} className={cn(FIELD_SURFACE, "h-8 appearance-none pl-2.5 pr-8")} {...props}>
        {children}
      </select>
      <ChevronDown aria-hidden size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
    </span>
  );
});

/** A search box: the magnifier inside it, and the label a screen reader needs. */
export function SearchInput({
  value,
  onChange,
  label,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex min-w-0", className)}>
      <Search aria-hidden size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD_SURFACE, "h-8 pl-8 pr-2.5")}
      />
    </span>
  );
}

/**
 * A labelled field. The label wraps the control, so clicking the words
 * focuses it and a screen reader names it, with no id to keep in step.
 * The hint and the error sit under the label rather than inside it, so
 * the control's name stays its label alone.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  // The hint and the error describe the control, so a screen reader reads
  // them on it: handed to the one control the field wraps.
  const control =
    described !== "" && isValidElement<{ "aria-describedby"?: string }>(children)
      ? cloneElement(children, { "aria-describedby": [children.props["aria-describedby"], described].filter(Boolean).join(" ") })
      : children;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-[12px] font-medium text-ink-muted">{label}</span>
        {control}
      </label>
      {hint ? (
        <span id={`${id}-hint`} className="text-[11.5px] leading-snug text-ink-subtle">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} role="alert" className="text-[11.5px] leading-snug text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * An on/off setting: the switch and what it does, on one row. A
 * `role="switch"` button rather than a checkbox, because it says what it
 * is — a setting that takes effect — and reads "on"/"off" aloud.
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-3", disabled && "opacity-60")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        {...(description ? { "aria-describedby": `${id}-description` } : {})}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 h-[18px] w-8 shrink-0 rounded-full transition-colors", checked ? "bg-accent" : "bg-canvas-active")}
      >
        <span
          aria-hidden
          className={cn(
            "absolute top-[3px] h-3 w-3 rounded-full transition-[left]",
            checked ? "left-[17px] bg-accent-ink" : "left-[3px] bg-ink-subtle",
          )}
        />
      </button>
      <span className="flex min-w-0 flex-col gap-0.5">
        {/* The words toggle it too, as a label does a checkbox. */}
        <span id={`${id}-label`} onClick={() => (disabled ? undefined : onChange(!checked))} className={cn("text-[13px] text-ink", !disabled && "cursor-pointer")}>
          {label}
        </span>
        {description ? (
          <span id={`${id}-description`} className="text-[12px] leading-snug text-ink-subtle">
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  /** The box's name, where the label drawn beside it is built from pieces a screen reader would run together. */
  ariaLabel?: string;
}) {
  return (
    <label className={cn("inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink", disabled && "cursor-default opacity-60")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cn(
          "grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border-[1.5px] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-focus",
          checked ? "border-accent bg-accent text-accent-ink" : "border-line-strong",
        )}
      >
        {checked ? <Check size={11} strokeWidth={3} /> : null}
      </span>
      {label}
    </label>
  );
}

/**
 * A choice of one among a few, drawn as a row of segments. Radio
 * semantics: it is a value, not a set of pages — for pages, see `Tabs`.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = "md",
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  size?: "md" | "sm";
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex shrink-0 gap-0.5 rounded-[10px] bg-canvas-raised p-0.5"
      onKeyDown={(event) => {
        // A radio group is one stop for Tab, and the arrows choose within it.
        const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (step === 0) return;
        event.preventDefault();
        const at = options.findIndex((option) => option.value === value);
        const next = options[(at + step + options.length) % options.length]!;
        onChange(next.value);
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
        buttons[options.indexOf(next)]?.focus();
      }}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          // One stop for Tab: the chosen option, or the first when none is.
          tabIndex={option.value === value || (index === 0 && !options.some((candidate) => candidate.value === value)) ? 0 : -1}
          {...(option.title ? { title: option.title } : {})}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-[8px] px-2.5",
            size === "sm" ? "h-[22px] text-[11.5px]" : "h-7 text-[12.5px]",
            option.value === value ? "bg-canvas-active text-ink" : "text-ink-subtle hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Pages of one view, as tabs: `role="tab"` buttons over whichever panel the view draws. */
export function Tabs<T extends string>({
  label,
  value,
  tabs,
  onChange,
}: {
  label: string;
  value: T;
  tabs: readonly { value: T; label: ReactNode; count?: number }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-3 text-[12.5px]",
            tab.value === value ? "bg-canvas-raised text-ink" : "text-ink-subtle hover:bg-canvas-subtle hover:text-ink-muted",
          )}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="text-[11px] tabular-nums text-ink-subtle">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
