import type { ReactNode } from "react";
import { ItemKeyLink, ReferenceText } from "../../conversation/references";

/**
 * Item keys on an item's page and in the list, drawn as those views draw
 * them. What a key resolves to is `conversation/references`' alone.
 */

/**
 * One item key: a link when it resolves, text when it does not. `itemId`
 * is a target the caller already knows — a dependency on another project,
 * which this project's catalog does not hold.
 */
export function ItemRef({ itemKey, itemId, className, children }: { itemKey: string; itemId?: string; className?: string; children?: ReactNode }) {
  return (
    <ItemKeyLink itemKey={itemKey} itemId={itemId} {...(className ? { className } : {})}>
      {children}
    </ItemKeyLink>
  );
}

/**
 * Text the main process or an agent wrote — a refusal, an error, a
 * criterion — with every key in it that resolves turned into a link.
 * Inside backticks nothing is linked: code is quoted, not referred to.
 */
export function RefText({ children, linkClassName = "text-accent-soft underline underline-offset-2" }: { children: string; linkClassName?: string }) {
  return <ReferenceText linkClassName={linkClassName}>{children}</ReferenceText>;
}
