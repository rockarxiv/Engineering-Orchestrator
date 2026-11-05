import type { ReactNode } from "react";
import { cn } from "@eo/ui";

/** Small pieces the item and runs views share. */

/** A person's or an agent's initial, in a round mark. Decorative: the name is always beside it. */
export function Initial({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-canvas-active text-[10px] font-semibold uppercase text-ink-muted", className)}
    >
      {name.trim().charAt(0) || "?"}
    </span>
  );
}

/** When something happened, as a person reads a date and time. */
export function when(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** `send_back` → "send back": an id said as words. */
export function spoken(id: string): string {
  return id.replace(/_/g, " ");
}

/** "1 run", "2 runs". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Enough of a comment to be sure it is the right one, without pasting an essay into a dialog. */
export function excerpt(body: string, limit = 120): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit).trimEnd()}…`;
}

/** A sentence the view says about what it just did: a quiet status line. */
export function StatusLine({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "danger" | "paused" }) {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={cn("text-[12px] leading-snug", tone === "danger" ? "text-danger" : tone === "paused" ? "text-paused" : "text-ink-muted")}
    >
      {children}
    </p>
  );
}

/** A row of small actions under an editor: Save, Cancel. */
export function EditorActions({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
      {note ? <p className="text-[11.5px] leading-snug text-ink-subtle">{note}</p> : null}
    </div>
  );
}
