import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useProjects } from "../query/useRepositories";
import type { CanvasTab } from "./ChatCanvas";
import { chatViewFor, tabKeyOf, type ChatView } from "./views/registry";

/** How many views keep a tab. */
export const TAB_LIMIT = 8;

/**
 * The tab an address belongs in, or null for an address no view draws.
 *
 * A tab is a function of where it was last: its view and its key are
 * read off the address, which is why a window handed another window's
 * tabs is handed addresses and nothing else (EO-383).
 */
export function tabForPath(path: string): CanvasTab | null {
  const at = path.indexOf("?");
  const view = chatViewFor(at === -1 ? path : path.slice(0, at), at === -1 ? "" : path.slice(at));
  return view === null ? null : { key: tabKeyOf(view), path, view };
}

/** Addresses as tabs, one per thing, the later address winning its tab's place in the row. */
export function tabsForPaths(paths: readonly string[]): CanvasTab[] {
  const tabs: CanvasTab[] = [];
  for (const path of paths) {
    const tab = tabForPath(path);
    if (tab === null) continue;
    const at = tabs.findIndex((existing) => existing.key === tab.key);
    if (at === -1) tabs.push(tab);
    else tabs[at] = tab;
  }
  return tabs.slice(-TAB_LIMIT);
}

/**
 * The row with one tab opened in it: in its own place if it was there,
 * at the end if it was not.
 *
 * `replaces` names a tab the opened one takes over. It takes that tab's
 * place — or, already having one of its own, leaves that tab gone.
 */
export function recordTab(current: readonly CanvasTab[], tab: CanvasTab, replaces: string | null = null): CanvasTab[] {
  const has = current.some((existing) => existing.key === tab.key);
  const taken = replaces !== null && replaces !== tab.key;
  const row = current.flatMap((existing) => {
    if (existing.key === tab.key) return [tab];
    if (taken && existing.key === replaces) return has ? [] : [tab];
    return [existing];
  });
  return has || row.some((existing) => existing.key === tab.key) ? row : [...row, tab];
}

/**
 * The canvas's row of tabs: one for each view opened this session, newest
 * last, each remembering where in it the person last was.
 *
 * One hook for the two places a canvas is drawn — beside the
 * conversation, and in a window of its own (EO-383) — so the row behaves
 * the same in both.
 */
export function useCanvasTabs({
  view,
  tabKey,
  here,
  recording = true,
  onEmpty,
}: {
  /** The view the address names, or null. */
  view: ChatView | null;
  tabKey: string | null;
  /** The address, path and query. */
  here: string;
  /** False while this window draws no canvas: views opened are another window's tabs. */
  recording?: boolean;
  /** The open tab was closed and it was the last. */
  onEmpty: () => void;
}): {
  tabs: CanvasTab[];
  closeTab: (key: string) => void;
  /** Replaces the row — with another window's tabs, or with nothing. */
  replaceTabs: (paths: readonly string[]) => void;
} {
  const navigate = useNavigate();
  // A view that became another says which tab the new address takes over
  // (`replacesTab`): a proposed item, approved, is the created item in the
  // same place in the row rather than a dead tab beside a new one (EO-408).
  const { state } = useLocation();
  const replaces = typeof state === "object" && state !== null && "replacesTab" in state && typeof state.replacesTab === "string" ? state.replacesTab : null;
  const [opened, setOpened] = useState<CanvasTab[]>([]);
  /**
   * The address of the open tab just closed, until the next recording.
   *
   * The row draws the open view's tab before the effect below has
   * recorded it (`tabs`, further down), so the tab can be closed in that
   * gap. The effect for its address then runs *after* the close and
   * would put the tab straight back — it had been queued before the
   * click and knows nothing of it. Closing notes the address; the one
   * recording that runs for it is skipped, and any recording clears it,
   * so opening the same view again later records as ever.
   */
  const closedAt = useRef<string | null>(null);
  useEffect(() => {
    const justClosed = closedAt.current === here;
    closedAt.current = null;
    if (justClosed || !recording || view === null || tabKey === null) return;
    setOpened((current) => recordTab(current, { key: tabKey, path: here, view }, replaces).slice(-TAB_LIMIT));
    // `view` and `tabKey` are functions of the address, which is what this is keyed on.
  }, [here, recording]);
  // A tab names a board or an item of the project it was opened in, so
  // switching project starts the row afresh rather than keeping tabs that
  // could only say "Pipeline" and "Item".
  const { activeProjectId } = useProjects();
  const projectBefore = useRef(activeProjectId);
  useEffect(() => {
    // Only on a real switch: the first answer arriving is not one. The view
    // open now keeps its tab: following a link into another project is a
    // switch too, and its own tab must survive it.
    if (projectBefore.current !== undefined && projectBefore.current !== null && projectBefore.current !== activeProjectId) {
      setOpened(!recording || view === null || tabKey === null ? [] : [{ key: tabKey, path: here, view }]);
    }
    projectBefore.current = activeProjectId;
  }, [activeProjectId]);
  // The view open now always has its tab, including on the render before
  // the effect above has recorded it.
  const tabs: CanvasTab[] = view === null || tabKey === null ? opened : recordTab(opened, { key: tabKey, path: here, view }, replaces);

  const closeTab = (key: string) => {
    const remaining = tabs.filter((tab) => tab.key !== key);
    setOpened(remaining);
    if (key !== tabKey) return;
    closedAt.current = here;
    const at = tabs.findIndex((tab) => tab.key === key);
    const next = remaining[Math.max(0, at - 1)];
    if (next) void navigate(next.path);
    else onEmpty();
  };

  const replaceTabs = useCallback((paths: readonly string[]) => setOpened(tabsForPaths(paths)), []);

  return { tabs, closeTab, replaceTabs };
}
