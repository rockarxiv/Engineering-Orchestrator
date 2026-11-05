import type { ReactNode } from "react";
import { cn } from "@eo/ui";

/**
 * Everything inside this cannot be operated (EO-326,
 * `ARCHITECTURE.md`, "Identity").
 *
 * The classic `admin/ReadOnlyFence`, for the chat layout's screens: a
 * `<fieldset disabled>`, the one thing in HTML that disables a region
 * rather than a control, so a button added inside it later is disabled
 * without anybody having to remember to pass it a prop. Fail-closed is the
 * whole point. `display: contents` takes the fieldset's own box away, so
 * a fence changes what a control does and nothing about where it sits.
 *
 * It catches real form controls only. A link still navigates (reading is
 * allowed), and anything that mutates is written as a `<button>` for
 * exactly this reason.
 */
export function ReadOnlyFence({
  readOnly,
  className,
  children,
}: {
  readOnly: boolean;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <fieldset disabled={readOnly} className={cn("contents", className)}>
      {children}
    </fieldset>
  );
}
