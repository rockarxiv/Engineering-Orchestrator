import type { ReactNode } from "react";
import { cn } from "@eo/ui";
import { ItemKeyLink as SharedKeyLink, ReferenceText } from "../../conversation/references";

/**
 * Item keys as links, for the inbox, the archive, the open mentions, the
 * jobs and the discussions views.
 *
 * The catalogue that resolves a key is the app's (`ItemReferenceProvider`
 * fills it, `conversation/references` reads it), so a key resolves here exactly
 * when it resolves anywhere else: live and archived items link, a deleted
 * or unknown key stays plain text.
 *
 * A link never acts on the control around it — a row it sits in is not
 * selected, an option it sits in is not chosen — and it sits above the
 * overlay button those rows are drawn with, clickable through a drawing
 * that otherwise ignores the pointer.
 */

/** Above an overlay button, and clickable inside a row whose drawing ignores the pointer. */
const ABOVE = "pointer-events-auto relative z-10";

/** One key: a link to its item when the key resolves (or its id is already known), plain text otherwise. */
export function ItemKeyLink({ itemKey, itemId, className, children }: { itemKey: string; itemId?: string | null; className?: string; children?: ReactNode }) {
  return (
    <SharedKeyLink itemKey={itemKey} itemId={itemId} className={cn(ABOVE, "font-mono hover:text-ink", className)}>
      {children}
    </SharedKeyLink>
  );
}

/** Plain text with the keys in it linked: a row's preview, a refusal, a conversation's title. */
export function ItemText({ children, linkClassName }: { children: string; linkClassName?: string }) {
  return <ReferenceText linkClassName={cn(ABOVE, linkClassName)}>{children}</ReferenceText>;
}

/** "5m ago", "3h ago", "2d ago": how long something has been waiting — the classic inbox's own. */
export { age } from "../../../shared/inbox/inbox";
