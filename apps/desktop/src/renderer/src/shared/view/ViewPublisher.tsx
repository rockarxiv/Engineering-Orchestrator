import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { pageDescriptorFor, type PageDescriptor, type UnsavedEdit, type ViewFilter, MAX_UNSAVED_EDIT_VALUE } from "@eo/core";
import { machineAvailable } from "../../ipc/bridge";
import { ipcQuery } from "../../query/client";
import { isCanvasWindow, useCanvasWindowState } from "../../chat/canvasPopOut";

/**
 * The renderer's half of "what is on screen" (EO-192).
 *
 * Only the renderer knows what is displayed, so it has to say — and what
 * it is allowed to say is the whole design. It publishes **identifiers
 * and view parameters**: which route matched, its parameters, the filter
 * as typed, which ids are selected, how the table is ordered, and what
 * has been typed into a field and not saved. Never a sentence about an
 * item, and never a fact it looked up. The main process resolves the
 * identifiers against the database, so what an agent reads is what EO
 * found rather than what a query cache believed a moment ago.
 *
 * Published on navigation and whenever any of it changes, replacing what
 * was there. Nothing is stored: the main process holds one snapshot in
 * memory, which is what lets an agent call `view_current` twice across a
 * walk and get two different screens with nothing dispatched in between.
 *
 * **Why a context rather than a hook per screen.** The route is known
 * here, at the top; the filter and the selection are known three
 * components down, by whichever screen owns them. A screen that
 * published on its own would have to know the route too, and two
 * publishers racing on one navigation is how a screen comes to be
 * described with the last one's filter. So a screen contributes its
 * parameters and this component sends them, once, with the route it
 * actually belongs to.
 *
 * Registrations are stamped with the *page* — route and parameters —
 * rather than the route pattern, so walking between two items' run
 * pages discards the first one's selection like any other navigation.
 *
 * **Several contributors at once is the ordinary case**, not an edge:
 * Settings renders Projects and Repositories together, so two editors
 * can be open holding text nobody has saved. Registrations are keyed and
 * merged rather than overwritten — see `combine`.
 */

interface Registration {
  /**
   * The page these parameters belong to.
   *
   * Carried and checked rather than assumed, because unmount and mount
   * do not straddle a navigation neatly: React runs the leaving screen's
   * cleanup and the arriving screen's effect in an order that is not
   * ours to rely on, and the location changes independently of both. A
   * registration for a page we have left is a leftover, and publishing
   * it would describe the new screen with the old screen's filter — for
   * a moment, and a moment is all a tool call takes.
   *
   * The **page**, not the route pattern. `/items/:itemId/runs` is
   * one route and two screens: walking from item A's runs to item
   * B's keeps the pattern, so a check on the pattern alone would let A's
   * open-run selection be published against B's descriptor until the
   * child effect caught up. That is the same defect the check exists to
   * prevent, hiding inside a navigation that never changes route.
   */
  page: string;
  filter: ViewFilter | null;
  selection: string[];
  sort: string | null;
  unsavedEdits: UnsavedEdit[];
}

/**
 * One contributor announcing itself, or withdrawing.
 *
 * Keyed, because a screen can have more than one at a time and routinely
 * does: Settings renders Projects and Repositories together, so an "Add
 * project" form and a repository editor are both open, both hold text
 * nobody has saved, and an answer carrying one of them is an answer that
 * says the other does not exist. Keyed by `useId`, which is stable for
 * the life of a component instance and unique across them — the two
 * properties a caller-supplied name would have to promise and would
 * eventually get wrong.
 */
type Register = (id: string, value: Registration | null) => void;

/**
 * Which page this is, handed down rather than read.
 *
 * A screen contributing parameters has no business calling
 * `useLocation` — it does not care where it is, only what it is showing,
 * and requiring a router around every such component would make a filter
 * publishable only from inside one. The provider knows the page; it
 * passes it down, and a consumer stamps its registration with it.
 *
 * Outside the provider this is a no-op with an empty page, so a
 * component rendered on its own — in a test, or in a dialog mounted
 * elsewhere — publishes nothing rather than failing.
 */
const ViewContext = createContext<{ page: string; register: Register }>({ page: "", register: () => {} });

/**
 * A page as one string, for comparing two of them.
 *
 * Route *and* parameters, because the route alone is not an identity:
 * two items' run pages share `/items/:itemId/runs`, and a
 * registration stamped with the pattern would survive a walk between
 * them. Parameter names are sorted so the same page always spells
 * itself the same way, whatever order they were matched in.
 */
function pageIdentity(page: PageDescriptor): string {
  const params = Object.keys(page.params)
    .sort()
    .map((name) => `${name}=${page.params[name] ?? ""}`)
    .join("&");
  return params === "" ? page.route : `${page.route}?${params}`;
}

/** What a screen contributes. Everything is optional; a screen with none of it publishes its route alone. */
export interface ViewParametersInput {
  /** The screen's filter, as set. Omit on a screen that has none — that is different from an empty one. */
  filter?: ViewFilter | null;
  /** Selected ids. Ids, never rows: resolving them is the handler's job. */
  selection?: string[];
  /** `<column>:asc` or `<column>:desc`. */
  sort?: string | null;
  /** Typed and not saved. See `UnsavedEditSchema` — these are never presented as stored values. */
  unsavedEdits?: UnsavedEdit[];
}

/**
 * Everything mounted right now, as one view.
 *
 * `unsavedEdits` concatenate, because several editors open at once is
 * the ordinary case and each one's text is a separate thing the person
 * has typed. A screen has only one ordering and one selection, so those
 * take the first contributor that offers one, in mount order — a
 * deterministic answer to a situation that is a screen-authoring mistake
 * rather than a state to model.
 *
 * **Filters merge**, which is the one that is not a mistake. A screen's
 * narrowing is not always owned by one component: Agent tools holds
 * which catalogue is open while each catalogue holds its own *Show
 * archived*, and the button belongs beside the list it reveals rather
 * than lifted into a parent that would then have to keep two copies of
 * it. Taking the first filter would silently drop the other, and the
 * answer would be unable to tell a live-only list from one showing
 * archived rows.
 *
 * Registrations belonging to a page we have already left are dropped
 * here, which is where the guard has to be. See `Registration.page`.
 */
function combine(registrations: ReadonlyMap<string, Registration>, page: string): Omit<Registration, "page"> {
  const live = [...registrations.values()].filter((registration) => registration.page === page);

  return {
    filter: mergeFilters(live.map((registration) => registration.filter)),
    sort: live.find((registration) => registration.sort !== null)?.sort ?? null,
    selection: live.flatMap((registration) => registration.selection),
    unsavedEdits: live.flatMap((registration) => registration.unsavedEdits),
  };
}

/**
 * One filter out of however many parts of a screen narrow it.
 *
 * Facets union by name; a name two contributors both claim keeps the
 * first, in mount order, because that is a screen-authoring mistake and
 * the useful property is that it resolves the same way twice rather than
 * that it resolves cleverly. `text` is the one search box a screen has,
 * so the first non-empty one wins — a component contributing facets
 * alone sends `""` and cannot blank out the box beside it.
 *
 * Null only when nothing narrows this screen at all, which stays
 * distinct from a filter that is set to nothing: `filter: null` says the
 * screen has none, and the reply says so in those words.
 */
function mergeFilters(filters: readonly (ViewFilter | null)[]): ViewFilter | null {
  const present = filters.filter((filter): filter is ViewFilter => filter !== null);
  if (present.length === 0) return null;

  const facets: Record<string, string> = {};
  for (const filter of present) {
    for (const [name, value] of Object.entries(filter.facets)) if (!(name in facets)) facets[name] = value;
  }

  return { text: present.find((filter) => filter.text.trim() !== "")?.text ?? present[0]?.text ?? "", facets };
}

/**
 * Truncated here rather than rejected at the boundary.
 *
 * A field can hold an agent's whole instructions, and a publish that
 * failed its own schema would take the route and the filter down with
 * it — the screen would go dark to the agent because somebody pasted
 * three paragraphs into a text area.
 */
function capped(edits: UnsavedEdit[]): UnsavedEdit[] {
  return edits.map((edit) => ({ field: edit.field, value: edit.value.slice(0, MAX_UNSAVED_EDIT_VALUE) }));
}

/**
 * Publishes what a screen has set, for as long as it is mounted.
 *
 * Serialised into the dependency list rather than compared by identity,
 * so a caller can pass an object literal without an effect that fires on
 * every render — which, on a screen that publishes what is in a text
 * box, would be one IPC call per keystroke either way, but a *loop* if
 * the state it set fed back into a re-render.
 */
export function useViewParameters(input: ViewParametersInput): void {
  const { page, register } = useContext(ViewContext);
  const id = useId();

  const serialised = JSON.stringify({
    page,
    filter: input.filter ?? null,
    selection: input.selection ?? [],
    sort: input.sort ?? null,
    unsavedEdits: capped(input.unsavedEdits ?? []),
  });

  useEffect(() => {
    register(id, JSON.parse(serialised) as Registration);
    return () => register(id, null);
  }, [id, register, serialised]);
}

/** Where the person is, as a descriptor the main process can resolve. */
export function usePageDescriptor(): PageDescriptor {
  const { pathname } = useLocation();
  return useMemo(() => pageDescriptorFor(pathname), [pathname]);
}

/**
 * Sends the current view to the main process, and keeps sending it.
 *
 * Mounted once, beside `<Routes>`, so it survives every navigation —
 * a publisher inside a screen would unmount on the walk it most needs to
 * report.
 *
 * A failed publish is swallowed. The window telling the main process
 * what it is showing is not something a person asked for, and a toast
 * about it would be an error about a feature they have never used; the
 * cost of losing one is that `view_current` describes the previous
 * screen until the next change, which the tool's own answer already
 * warns is possible.
 *
 * Two windows render this now (EO-337) and only one of them may speak.
 * See the effect below.
 */
export function ViewPublisher({ children }: { children: ReactNode }) {
  const page = usePageDescriptor();
  const { poppedOut } = useCanvasWindowState();
  const [registrations, setRegistrations] = useState<ReadonlyMap<string, Registration>>(() => new Map());

  // Stable, so `useViewParameters`'s effect does not re-run on every
  // render of this provider — which is every navigation, and would
  // re-register every screen's parameters for no reason. A new Map each
  // time rather than a mutated one, because the state has to change
  // identity for the publish below to notice.
  const register = useCallback<Register>((id, value) => {
    setRegistrations((current) => {
      const next = new Map(current);
      if (value === null) next.delete(id);
      else next.set(id, value);
      return next;
    });
  }, []);

  // The whole page, not its route pattern. See `Registration.page`.
  const identity = pageIdentity(page);
  const parameters = useMemo(() => combine(registrations, identity), [registrations, identity]);

  const payload = useMemo(
    () => ({
      page,
      filter: parameters.filter,
      selection: parameters.selection,
      sort: parameters.sort,
      unsavedEdits: parameters.unsavedEdits,
    }),
    [page, parameters],
  );

  const serialised = JSON.stringify(payload);
  useEffect(() => {
    // What the window is showing is a fact about a window, and a server
    // has none (EO-319): `view:publish` is in the machine half and would
    // be refused. Skipped rather than refused-and-swallowed, because
    // this runs on every keystroke that changes a filter.
    if (!machineAvailable()) return;
    // With the canvas popped out into its own window (EO-383), that
    // window is the screen about something and this one is the
    // conversation, so this one keeps quiet.
    //
    // `ipc/currentView.ts` holds **one** snapshot, because there is one
    // screen in front of one person. A publish from the conversation's
    // window would overwrite it, and `view_current` would start answering
    // the agent with a description of the conversation it is having
    // instead of the work beside it. And a view opened here is handed
    // across to the canvas window (`ChatFrame`), so this window is on that
    // view's address for a moment on the way — a publish from here would
    // overwrite what the canvas window said with a screen nobody is
    // shown, and then with `/chat`. The canvas window itself always
    // speaks. When the canvas comes back or closes, this runs again and
    // this window says where it is.
    if (poppedOut && !isCanvasWindow()) return;
    void ipcQuery("view:publish", JSON.parse(serialised)).catch(() => {});
  }, [serialised, page.route, poppedOut]);

  const context = useMemo(() => ({ page: identity, register }), [identity, register]);

  return <ViewContext.Provider value={context}>{children}</ViewContext.Provider>;
}
