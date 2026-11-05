import type { ReactNode } from "react";
import { cn } from "@eo/ui";
import { ItemKeyLink, ReferenceText as SharedReferenceText } from "../../conversation/references";

/**
 * Item keys on the board, drawn as the board draws them. What a key
 * resolves to is `conversation/references`' alone.
 */

/** One key on a card or in a dialog: mono, and clickable through a card that is being dragged about. */
export function KeyLink({ itemKey, itemId, className }: { itemKey: string; itemId?: string | null | undefined; className?: string }) {
  return <ItemKeyLink itemKey={itemKey} itemId={itemId} className={cn("pointer-events-auto font-mono hover:text-ink", className)} />;
}

/** Text somebody wrote, with the keys in it linked and code spans left alone. */
export function ReferenceText({ children }: { children: string }): ReactNode {
  return <SharedReferenceText linkClassName="pointer-events-auto underline">{children}</SharedReferenceText>;
}
