import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { MarkdownItemReferenceProvider, createItemReferenceMatcher } from "@eo/ui";
import { itemReferencesKey, sameItemCatalog, type ItemCatalog } from "../../shared/items/itemReference";
import { archivedKey } from "../../shared/pipeline/archive";
import { ipcQuery } from "../../query/client";
import { itemsKey, projectsKey } from "../../query/hooks";
import { useProjects } from "../../query/useRepositories";
import { useInvalidateOnPush } from "../../query/useInvalidateOnPush";
import { ItemCatalogProvider, ItemKeyLink, type ItemCatalogValue } from "./references";

/** No catalog yet: nothing is a key. One for the whole app, so it is never new. */
const NO_KEYS = createItemReferenceMatcher([]);

/**
 * Hands the item keys EO holds for the project in view to the Markdown
 * renderer, once for the whole window, so a key in a message or a comment
 * is drawn as a link to its item.
 *
 * The one owner of the catalog. Everything else that links a key —
 * `ItemKeyLink`, `ReferenceText` — reads what this hands down
 * (`useItemCatalog`) rather than asking again, so the window holds one
 * opinion about which keys exist.
 *
 * **Read from the board's own list, not asked for again** (EO-560). The
 * live keys are the `itemsKey` query the board, the items list and the
 * frame already hold, and the archived ones the archive's own query, so
 * an `items:changed` costs one `items:list` however many of them are on
 * screen — where this used to issue its own beside the board's.
 *
 * Live and archived summaries are combined. Archiving is a change of
 * visibility, not identity, so a reference still leads to what was kept.
 * A deletion removes the summary from both, and the same reference falls
 * back to text.
 *
 * Each project's catalog is its own cache entry (`itemReferencesKey`), and
 * it is written only once the project, the list and the archive have all
 * settled, from answers asked for after that project came into view.
 * `itemsKey` is not keyed by project — it is whatever the active one is —
 * so writing from a read begun before a switch could file one project's
 * keys under the other's.
 *
 * **An unchanged catalog keeps its identity** (EO-561). Every `Markdown`
 * and every key on screen reads it, and a Map has no structural sharing in
 * the query cache, so a refetch that changed no key, id or title leaves the
 * entry as it was — and the matcher and context values built from it with
 * it. An `items:changed` that moved a card re-renders no sentence.
 */
export function ItemReferenceProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { activeProjectId, isLoading: projectsLoading } = useProjects();
  const live = useQuery({ queryKey: itemsKey, queryFn: () => ipcQuery("items:list", undefined), enabled: !projectsLoading });
  const archived = useQuery({ queryKey: archivedKey, queryFn: () => ipcQuery("items:listArchived", undefined), enabled: !projectsLoading });
  // Shared with every other listener on the same keys, so these cost
  // nothing where the frame or the archive already listens.
  useInvalidateOnPush("items:changed", itemsKey, !projectsLoading);
  useInvalidateOnPush("items:changed", archivedKey, !projectsLoading);

  // The project in view's entry: written below, never fetched — and held
  // by this observer, since an entry nothing observes is collected.
  const referencesKey = itemReferencesKey(activeProjectId);
  const references = useQuery({
    queryKey: referencesKey,
    queryFn: () => queryClient.getQueryData<ItemCatalog>(referencesKey) ?? new Map(),
    enabled: false,
  });

  const projectsFetching = useIsFetching({ queryKey: projectsKey, exact: true }) > 0;
  const settled = !projectsLoading && !projectsFetching && live.data !== undefined && archived.data !== undefined && !live.isFetching && !archived.isFetching;
  const catalog = useMemo(
    () =>
      // Live entries win if a change is observed between the two reads.
      // The id is stable either way; this only makes the freshest summary win.
      settled
        ? (new Map(
            [...(archived.data?.items ?? []), ...(live.data?.items ?? [])].map(({ id, key, title }) => [key, { id, key, title }] as const),
          ) as ItemCatalog)
        : null,
    [settled, live.data, archived.data],
  );

  // Which project the catalog is being written for, and how many answers
  // each list had already taken when it became the one in view.
  //
  // A switch made here invalidates the list itself (`useProjects`), but
  // one made in another window reaches this one as `config:changed` and
  // leaves the list as it was. Either way a read may be in flight that
  // was asked for the project before — and TanStack keeps such a read
  // rather than starting another (always for a list with no answer yet,
  // and for any read asked again with `cancelRefetch: false`), so when it
  // lands it would look like the new project's answer. So a new project
  // cancels both reads, which throws away whatever they bring back, asks
  // again, and writes nothing until each list has taken an answer since:
  // one asked for after the switch, so the new project's.
  const generation = useRef<{ projectId: string | null; live: number; archived: number } | undefined>(undefined);
  useEffect(() => {
    if (projectsLoading) return;
    const answers = (queryKey: readonly unknown[]) => queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0;
    const known = generation.current;
    if (known !== undefined && known.projectId !== activeProjectId) {
      for (const queryKey of [itemsKey, archivedKey]) void queryClient.cancelQueries({ queryKey, exact: true });
      generation.current = { projectId: activeProjectId, live: answers(itemsKey), archived: answers(archivedKey) };
      for (const queryKey of [itemsKey, archivedKey]) void queryClient.invalidateQueries({ queryKey, exact: true });
      return;
    }
    // The first project in view: every answer so far was asked for it.
    const current = known ?? { projectId: activeProjectId, live: -1, archived: -1 };
    generation.current = current;
    if (catalog === null) return;
    if (answers(itemsKey) <= current.live || answers(archivedKey) <= current.archived) return;
    const written = queryClient.getQueryData<ItemCatalog>(itemReferencesKey(activeProjectId));
    if (written !== undefined && sameItemCatalog(written, catalog)) return;
    queryClient.setQueryData(itemReferencesKey(activeProjectId), catalog);
  }, [catalog, activeProjectId, projectsLoading, queryClient]);

  const renderMarkdownItemReference = useCallback(
    (itemKey: string) => <ItemKeyLink itemKey={itemKey} className="text-accent underline underline-offset-2" />,
    [],
  );

  // Compiled once per catalog, and shared by `Markdown` and `ReferenceText`.
  const value = useMemo<ItemCatalogValue | null>(
    () => (references.data === undefined ? null : { catalog: references.data, matcher: createItemReferenceMatcher(references.data.keys()) }),
    [references.data],
  );

  return (
    <ItemCatalogProvider value={value}>
      <MarkdownItemReferenceProvider matcher={value?.matcher ?? NO_KEYS} renderItemReference={renderMarkdownItemReference}>
        {children}
      </MarkdownItemReferenceProvider>
    </ItemCatalogProvider>
  );
}
