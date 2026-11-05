import { z } from "zod";
import { DEFAULT_PIPELINE_ID } from "../domain.js";

/**
 * Where an assist turn was asked from — the route, and the parameters
 * the router matched out of it (EO-189).
 *
 * The whole design of an assist turn's page context is in what this
 * shape *refuses* to carry. The renderer could describe the page in a
 * sentence, and the agent would then be acting on a description it was
 * handed: whatever the screen believed about the item, spelled by the
 * side of the app that has no database. What it sends instead is the two
 * facts a router already has — which route matched, and what the
 * parameters were — and the main process looks the rest up. Every fact
 * in the rendered section is then one EO resolved, which is invariant #5
 * applied to the one new input this feature adds.
 *
 * `route` is deliberately a free string rather than an enum of the
 * routes below. An enum would move the failure to the wrong place: an
 * unrecognised route would be rejected by the IPC boundary, and the
 * person's message — the thing they actually typed — would never reach
 * the agent at all. A route nobody recognises has to cost the *section*
 * and nothing else, so it is accepted here and resolves to nothing
 * downstream.
 */
export const PageDescriptorSchema = z.object({
  /** The route pattern the router matched, e.g. `/items/:itemId`. */
  route: z.string().min(1).max(200),
  /** Its parameters by name, e.g. `{ itemId: "019f…" }`. */
  params: z.record(z.string().min(1).max(64), z.string().min(1).max(200)).default({}),
});

export type PageDescriptor = z.infer<typeof PageDescriptorSchema>;

/** One route the assistant knows how to resolve. */
export interface AssistPageRoute {
  /** As the router declares it, `:param` segments and all. */
  route: string;
  /** The parameter naming the row this page is about, or null for a screen that is about no single row. */
  param: string | null;
  /**
   * What kind of screen this is: `item`, `pipeline`, or the name of a
   * screen that is about no single row.
   *
   * Two routes may share one, because they are the same screen reached
   * two ways: an item's page and its runs page are one item, and
   * `/project` and `/pipelines/<the board it draws>` are one board.
   *
   * It used to be the prefix of the conversation key as well, back when
   * there was a thread per page. There is one thread now (EO-193), so
   * `ipc/currentView.ts` is the only reader — it is what decides whether
   * a screen resolves to a row or to one of the named screens.
   */
  key: string;
  /**
   * The parameters this route's *path* does not carry and the screen
   * picks for itself.
   *
   * One route has any: `/project` draws the same board as
   * `/pipelines/:pipelineId` with nothing in its address, and the chat
   * layout falls back to `DEFAULT_PIPELINE_ID` there (EO-191). Stated here
   * so both sides fill the gap the same way — the renderer still sends
   * only what the router matched, and the id is supplied from this table
   * rather than asserted by the side of the app with no database.
   */
  implied?: Readonly<Record<string, string>>;
}

/**
 * The address of one proposed item (EO-408): an item a work proposal
 * would create, opened beside the conversation before it is filed.
 *
 * Named by the card's message and the item's place among its rows,
 * because that is all an unfiled item has — a key and an id are
 * allocated when it is created. Both are identifiers, so the main
 * process resolves the proposal behind them rather than being told it.
 *
 * Named here, in the package both halves of the app import, because
 * two processes have to agree about it: the chat layout's registry
 * reads it, and the view resolver in the main process matches it.
 */
export const PROPOSED_ITEM_ROUTE = "/proposals/:messageId/:index";

/** The address of the `index`th item of the proposal on message `messageId`. */
export function proposedItemPath(messageId: string, index: number): string {
  return `/proposals/${encodeURIComponent(messageId)}/${index}`;
}

/**
 * The address of a pipeline's Changes view (EO-524): a read-only diff
 * between two of its versions, or between this machine's own edits and
 * the version they were based on.
 *
 * Its own address rather than a mode of the editor's, because the
 * editor is gone (EO-525) and the diff is not: the board's banner, the
 * diverged chip and the Graph view's history all open it, and the
 * assistant reads the address to know what is being compared. Here for
 * `PROPOSED_ITEM_ROUTE`'s reason — the chat layout's registry reads it,
 * and the view resolver matches it.
 */
export const PIPELINE_CHANGES_ROUTE = "/pipelines/:pipelineId/changes";

/**
 * What a Changes view compares, as its address says it.
 *
 * `local` is this machine's edits to an organisation pipeline, against
 * the version the copy was based on. `versions` is two published
 * versions; a number left null is the view's default — the newest for
 * `to`, and the one before `to` for `from` — which is how the
 * channel behind it (`pipeline:versions`) reads an absent one.
 */
export type ChangesCompared = { kind: "local" } | { kind: "versions"; from: number | null; to: number | null };

/** The query parameter naming a Changes view on this machine's edits. */
export const CHANGES_LOCAL_PARAM = "local";

/** The address of `pipelineId`'s Changes view, comparing what `compared` names (by default the newest two versions, and this machine's edits beside them). */
export function pipelineChangesPath(pipelineId: string, compared: ChangesCompared = { kind: "versions", from: null, to: null }): string {
  const path = `/pipelines/${encodeURIComponent(pipelineId)}/changes`;
  if (compared.kind === "local") return `${path}?${CHANGES_LOCAL_PARAM}`;
  // Whole numbers only, so nothing here needs escaping — and this package has no DOM to borrow `URLSearchParams` from.
  const query = [compared.from === null ? null : `from=${compared.from}`, compared.to === null ? null : `to=${compared.to}`].filter((part) => part !== null).join("&");
  return query === "" ? path : `${path}?${query}`;
}

/** A version number out of an address, or null for one that is absent or not a whole positive number. */
function versionNumber(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const number = Number(raw);
  return number > 0 ? number : null;
}

/**
 * What a Changes view's address compares, read back from its query
 * parameters — by the view from its search, and by the view resolver
 * from the facets the view published. One reader, so the screen and
 * what the assistant is told about it cannot disagree.
 */
export function changesComparedOf(read: (name: string) => string | null): ChangesCompared {
  if (read(CHANGES_LOCAL_PARAM) !== null) return { kind: "local" };
  return { kind: "versions", from: versionNumber(read("from")), to: versionNumber(read("to")) };
}

/**
 * Which halves of the diff a Changes view draws.
 *
 * Its own edits alone when that is what the address asks for; the two
 * published versions alone when it names either; and, with nothing
 * named, both — the newest pair, with this machine's edits above them
 * when there are any, which is what the view always drew.
 */
export function changesShown(compared: ChangesCompared): { local: boolean; versions: boolean } {
  if (compared.kind === "local") return { local: true, versions: false };
  return { local: compared.from === null && compared.to === null, versions: true };
}

/**
 * Every route an assist conversation can be held from, and nothing else.
 *
 * A closed list on purpose. The alternative — guessing from the shape of
 * a path — is how an assistant comes to tell an agent it is looking at an
 * item that does not exist, and a section that invents its subject is
 * worse than no section at all. A route added to the app later resolves
 * to nothing until somebody adds it here, which is a missing paragraph
 * rather than a wrong one.
 *
 * `/discussions` is absent because nothing is drawn there: Discussions
 * is gone (EO-526), and its old addresses come home to the conversation.
 *
 * `/pipelines/:pipelineId/configure` is absent for the same reason: the
 * editor that drew it is gone (EO-525), and the chat layout replaces the
 * address with the pipeline's Graph view (`/pipelines/:pipelineId?view=graph`)
 * before it publishes anything — so the page a message is sent from is
 * the board's route, which names the pipeline a graph drafted there is
 * published against.
 *
 * `/` and the chat layout's home (`CHAT_HOME_ROUTE`) are absent because
 * neither is a screen about anything: `/` redirects to the home before
 * anything renders, and the home is the conversation with nothing open
 * beside it — so a descriptor for either would describe a page nobody is
 * looking at.
 *
 * That the list is closed is only worth anything if somebody notices a
 * screen falling through it, and for a year nothing did — `/project`
 * was recognised by no list and resolved to nothing (EO-191). So a view
 * added to the chat layout's registry (`chat/views/registry.tsx`) is a
 * decision about this list as well.
 */
export const ASSIST_PAGE_ROUTES: readonly AssistPageRoute[] = [
  { route: "/items/:itemId/runs", param: "itemId", key: "item" },
  { route: "/items/:itemId", param: "itemId", key: "item" },
  // An item that is not filed yet (EO-408). Its own key rather than
  // `item`'s: there is no row to look up, and what resolves it is the
  // proposal on the message — so "split this one in two" is about a
  // proposed item and nothing an agent could mistake for one on a board.
  { route: PROPOSED_ITEM_ROUTE, param: "messageId", key: "proposal" },
  // A pipeline's Changes view (EO-524). Its own key, because what is on
  // the screen is two versions and what changed between them rather than
  // a board — but it names the pipeline, so a draft raised from it is
  // published against that pipeline as one raised from its board is.
  { route: PIPELINE_CHANGES_ROUTE, param: "pipelineId", key: "pipelineChanges" },
  { route: "/pipelines/:pipelineId", param: "pipelineId", key: "pipeline" },
  // The same board as the route above, reached without naming it: a
  // link that knows of no particular pipeline — a job or a template with
  // none — points here. It resolves to the pipeline that screen draws
  // and shares that pipeline's key, because one board is one screen
  // however you walked onto it (EO-191).
  { route: "/project", param: "pipelineId", key: "pipeline", implied: { pipelineId: DEFAULT_PIPELINE_ID } },
  // Both of Jobs' routes, sharing one key and naming no parameter
  // (EO-308). The list screen and one job's page are the same kind of
  // screen to the assistant, and `param` is null on the second
  // deliberately: EO resolves a *row* for an item and for a pipeline,
  // and a job is neither — naming a parameter here would promise a
  // lookup `currentView.ts` cannot make, which is the wrong paragraph
  // rather than the missing one. The more specific path is first, for
  // the reason the item routes are.
  { route: "/jobs/:jobId", param: null, key: "jobs" },
  { route: "/jobs", param: null, key: "jobs" },
  { route: "/items", param: null, key: "items" },
  { route: "/inbox", param: null, key: "inbox" },
  { route: "/archive", param: null, key: "archive" },
  // Every unaddressed mention on the record (EO-326, ARCHITECTURE.md, "Identity"). No
  // parameter and no row, like `/archive` above: it is a screen about a
  // set rather than about one thing. It resolves to no listing either,
  // which `resolveMatching` answers by saying so — the rows here are
  // other people's, and a reply that listed them would be handing an
  // agent the survey the channel itself is kept out of the tool
  // catalogue to avoid.
  { route: "/mentions", param: null, key: "mentions" },
  { route: "/agents", param: null, key: "agents" },
  { route: "/agent-tools", param: null, key: "agent-tools" },
  // The gallery (EO-316). No parameter and no row: a template is a file
  // rather than something EO holds, so `currentView.ts` has a paragraph
  // about the screen and nothing to look up — which is the same shape
  // Jobs' list route has.
  { route: "/gallery", param: null, key: "gallery" },
  { route: "/settings", param: null, key: "settings" },
];

/** The route this descriptor names, or undefined when it names none of ours. */
export function assistPageRouteOf(page: PageDescriptor): AssistPageRoute | undefined {
  return ASSIST_PAGE_ROUTES.find((candidate) => candidate.route === page.route);
}

/**
 * The row this page is about, or null when it is about no single row.
 *
 * Asked by both sides that care which row a screen names — the view
 * resolver, and the assist room deciding which pipeline a draft would be
 * published against — and answered here so the two cannot disagree. They
 * would: a page whose id is implied rather than carried (`/project`)
 * would otherwise need the fallback written out at both call sites, and
 * the failure that makes is a Publish button over a board nobody is
 * looking at.
 *
 * Null covers a route nobody listed, a screen that is about no row, and
 * a parameter that never arrived — which the caller treats the same way,
 * because in each case there is nothing to name.
 */
export function assistPageSubjectOf(page: PageDescriptor): string | null {
  const known = assistPageRouteOf(page);
  if (!known || known.param === null) return null;

  const value = page.params[known.param] ?? known.implied?.[known.param];
  return value === undefined || value === "" ? null : value;
}

/** A path with any trailing slash removed, so `/agents/` and `/agents` are one page. */
function normalisePath(pathname: string): string {
  const trimmed = pathname.trim();
  const withoutTrailing = trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
  return withoutTrailing === "" ? "/" : withoutTrailing;
}

/**
 * The parameters a route pattern pulls out of a path, or null when it
 * does not match it — segment by segment, with each parameter decoded.
 */
function matchRoute(route: string, path: string): Record<string, string> | null {
  const pattern = route.split("/").filter((segment) => segment !== "");
  const segments = path.split("/").filter((segment) => segment !== "");
  if (pattern.length !== segments.length) return null;

  const params: Record<string, string> = {};
  for (const [index, part] of pattern.entries()) {
    const actual = segments[index] ?? "";
    if (part.startsWith(":")) {
      if (actual === "") return null;
      params[part.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (part !== actual) return null;
  }
  return params;
}

/**
 * The chat layout's home: the assistant with nothing open beside it.
 *
 * The chat layout draws the assistant's room as the window's spine, with
 * every other screen opening beside it. This address is the one place
 * that is the room alone, and it is where `/` goes: the page *is* the
 * assistant.
 *
 * It is not a page an assist turn can be about, and it is deliberately
 * absent from `ASSIST_PAGE_ROUTES`: a person on it is looking at the
 * conversation and nothing else, and a descriptor for it resolves to no
 * section, which is the truth.
 */
export const CHAT_HOME_ROUTE = "/chat";

/**
 * Whether a path is the chat layout's home (EO-383).
 *
 * Asked by the main process: with the canvas popped out into its own
 * window, the conversation is sent from this address, which names no
 * board — and the board is the one in the other window, which is what
 * was last published.
 */
export function isChatHomeRoute(pathname: string): boolean {
  return normalisePath(pathname) === CHAT_HOME_ROUTE;
}

/**
 * What marks the canvas's own window (EO-383), in the URL's query.
 *
 * Not a route: the canvas's window walks between every address a view
 * has — a board, an item, Settings — because a view *is* its address,
 * and the page it publishes is read off it. So what the window is cannot
 * be said in the hash a `HashRouter` rewrites on every navigation. It is
 * said in front of the hash instead (`index.html?window=canvas#/items/…`),
 * where it stays for as long as the window does.
 *
 * Named here, in the package both halves of the app import, because the
 * platform builds the URL and the renderer reads it, in two processes.
 */
export const CANVAS_WINDOW_SEARCH = "window=canvas";

/** Whether a URL's query (`location.search`) is the canvas window's. */
export function isCanvasWindowSearch(search: string): boolean {
  // Split by hand: this package is built without the DOM's or Node's
  // globals, so there is no `URLSearchParams` to ask.
  return search.replace(/^\?/, "").split("&").includes(CANVAS_WINDOW_SEARCH);
}

/**
 * The descriptor for a path the person is on.
 *
 * Here rather than in the renderer because both sides have to agree
 * about the same route table, and this is the package that already
 * exists so that things crossing IPC cannot disagree about their shape.
 * The renderer calls this with `useLocation().pathname` and sends what
 * comes back; the main process matches `route` against the same table.
 *
 * An unmatched path becomes its own route with no parameters — honest
 * about where the person is, and resolvable by nothing, which is exactly
 * what an unrecognised page should be.
 */
export function pageDescriptorFor(pathname: string): PageDescriptor {
  const path = normalisePath(pathname);

  for (const candidate of ASSIST_PAGE_ROUTES) {
    const params = matchRoute(candidate.route, path);
    if (params) return { route: candidate.route, params };
  }

  return { route: path, params: {} };
}
