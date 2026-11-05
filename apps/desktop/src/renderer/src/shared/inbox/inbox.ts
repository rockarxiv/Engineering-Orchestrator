import type { ViewFilter } from "@eo/core";

export function age(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The filters, and the distinction the design insists on keeping straight.
 *
 * A mention does not by itself block an item; an item is blocked because
 * its run *ended awaiting a reply*. So Blocking comes from the run — which
 * is what `InboxItem.blocking` already carries — and never from the
 * mention row. Conflating the two makes an FYI look like a stoppage, and
 * hides the real ones among them.
 */
export type Filter = "all" | "blocking" | "mentions" | "fyi" | "unassigned";

/**
 * This screen's state as the filter that crosses IPC (EO-192).
 *
 * The tab is a facet and the search box is the text, so the main process
 * can resolve the same rows this list renders — see `matchesInboxFilter`
 * in `@eo/core`, which is what both sides ask. Written out here rather
 * than inlined so the counts above the tabs and the published filter
 * cannot describe two different questions.
 */
export function inboxViewFilter(filter: Filter, search = ""): ViewFilter {
  return { text: search, facets: { category: filter } };
}
