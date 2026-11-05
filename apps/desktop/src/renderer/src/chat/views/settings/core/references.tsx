import { ItemKeyLink as SharedKeyLink, ReferenceText } from "../../../conversation/references";

/**
 * Item keys in Settings — a worktree's item, a project's running work —
 * drawn as Settings draws them. What a key resolves to is
 * `conversation/references`' alone.
 */

/** One key: a link to its item when it resolves, plain text otherwise. */
export function ItemKeyLink({ itemKey, className }: { itemKey: string; className?: string }) {
  return <SharedKeyLink itemKey={itemKey} className={["font-mono", className].filter(Boolean).join(" ")} />;
}

/** A sentence with the keys in it linked. Code spans are left as they are. */
export function ItemText({ children }: { children: string }) {
  return <ReferenceText>{children}</ReferenceText>;
}
