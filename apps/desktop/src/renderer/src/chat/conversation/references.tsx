import { Fragment, createContext, useContext, type ReactNode, type SyntheticEvent } from "react";
import { Link } from "react-router-dom";
import { cn, splitItemReferenceText, type ItemReferenceMatcher } from "@eo/ui";
import type { ItemCatalog } from "../../shared/items/itemReference";

/** The project in view's catalog, and the one matcher compiled from its keys. */
export interface ItemCatalogValue {
  catalog: ItemCatalog;
  matcher: ItemReferenceMatcher;
}

/**
 * Where `ItemReferenceProvider` hands its catalog down (EO-561).
 *
 * A context rather than a read of the query cache: subscribing to the
 * cache woke every key and every sentence on screen at each event of any
 * query in the window. A context reaches its readers only when its value
 * changes, and the provider keeps that value's identity while no key or
 * title has.
 */
const ItemCatalogContext = createContext<ItemCatalogValue | null>(null);

export const ItemCatalogProvider = ItemCatalogContext.Provider;

/**
 * The item keys EO holds for the project on screen, as the app's
 * `ItemReferenceProvider` already fetched them — or null where there is
 * no catalog to read.
 *
 * Handed down by the provider rather than asked for: it owns the fetch
 * (and its push invalidation), and a second query here would be a second
 * opinion about which keys exist. Outside the provider — a box rendered on
 * its own in a test, as the classic ones are — a catalog is simply absent,
 * which is what the classic renderer does outside its provider: the text,
 * unlinked.
 */
export function useItemCatalog(): ItemCatalog | null {
  return useContext(ItemCatalogContext)?.catalog ?? null;
}

const STRUCTURED_CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g;

/** An item link is never an instruction to the control around it. */
function stop(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * One item key: a link to its item when the key resolves (or the caller
 * already knows its id — a dependency on another project, which this
 * project's catalog does not hold), plain text otherwise (a deleted
 * item's key in an old comment).
 *
 * The one place the chat layout links a key. Each view styles it; what a
 * key resolves to, and that the link never presses the row or button it
 * sits in, is decided here.
 */
export function ItemKeyLink({
  itemKey,
  itemId,
  className,
  children,
}: {
  itemKey: string;
  itemId?: string | null | undefined;
  className?: string;
  children?: ReactNode;
}) {
  const catalog = useItemCatalog();
  const target = itemId ?? catalog?.get(itemKey)?.id ?? null;
  if (target === null) return <span className={className}>{children ?? itemKey}</span>;
  return (
    <Link to={`/items/${target}`} className={cn("hover:underline", className)} onClick={stop} onPointerDown={stop} onKeyDown={stop}>
      {children ?? itemKey}
    </Link>
  );
}

/**
 * Text that may name items — an error from the main process, a question's
 * heading, an option — with every key EO holds drawn as a link to it.
 *
 * The chat layout's own drawing of the classic `ItemReferenceContent`:
 * the same split (code spans are left as written, a key that no longer
 * resolves stays text), the link in the chat's accent unless the caller
 * says otherwise.
 */
export function ReferenceText({ children, linkClassName }: { children: string; linkClassName?: string }) {
  const references = useContext(ItemCatalogContext);
  if (references === null) return <>{children}</>;
  const { catalog, matcher } = references;

  return (
    <>
      {children
        .split(STRUCTURED_CODE)
        .filter(Boolean)
        .flatMap((piece, pieceIndex) => {
          if (piece.startsWith("`")) return [<Fragment key={`code-${pieceIndex}`}>{piece}</Fragment>];
          return splitItemReferenceText(piece, matcher).map((part, partIndex) => {
            const key = `${pieceIndex}-${partIndex}`;
            if (part.kind !== "item" || !catalog.has(part.value)) return <Fragment key={key}>{part.value}</Fragment>;
            return (
              <ItemKeyLink key={key} itemKey={part.value} className={cn("font-mono text-[0.92em] text-accent-soft underline-offset-2", linkClassName)} />
            );
          });
        })}
    </>
  );
}
