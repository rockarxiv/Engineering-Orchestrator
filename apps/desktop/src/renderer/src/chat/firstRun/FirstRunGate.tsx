import { startTransition, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { UNSAFE_NavigationContext, useLocation, type Navigator } from "react-router-dom";
import { ipcQuery } from "../../query/client";
import { firstRunKey } from "../../query/hooks";
import { useInvalidateOnPush } from "../../query/useInvalidateOnPush";
import { FirstRun } from "./FirstRun";

/**
 * What the window shows before there is anything of somebody's own
 * (EO-317, `ARCHITECTURE.md`, "What a person sees first").
 *
 * A gate rather than a route, because first run is a *state* the whole
 * window is in and not a place in it: there is no board to go back to,
 * no rail to navigate with, and nothing the other screens could
 * truthfully draw. A route would have been reachable by a stale hash and
 * escapable by one.
 *
 * **It answers "nothing yet" before it answers anything.** While the
 * question is in flight this renders nothing at all rather than the app
 * behind it: an installation halfway through first run must not be shown
 * a flash of an empty board with a sidebar saying "No project", which is
 * precisely the screen the design is replacing.
 *
 * **The flow keeps the window until one of its exits is taken.** What
 * ends first run is a real project — see `firstRunDone` — and the flow
 * is what *creates* that project, at step 4 of 6; the main process knows
 * not to count that one, so the needs check is not torn off the screen
 * by the very submission that produced its lines. The one thing held
 * here is that an exit *has* been taken, because both of them navigate
 * immediately and `firstRun:finish` is a round trip: without it the flow
 * would be drawn over the board for as long as that write took.
 *
 * **One screen is let through while the flow is still open: an item.**
 * Step 3 is "Preview, optional, before any sign-in — the person sees the
 * product work before it asks them for anything", and what they see is
 * the item: its card, its transcript, its banner. Holding the window on
 * the gallery while the rehearsal they just asked for ran somewhere they
 * could not look would be the flow talking over its own demonstration.
 * Everything else — the board, the archive, Settings — stays behind it,
 * because there is nothing of theirs for any of it to show yet, and
 * Templates in the rail is the way back to where they were.
 */
export function FirstRunGate({ children }: { children: ReactNode }) {
  const state = useQuery({ queryKey: firstRunKey, queryFn: () => ipcQuery("firstRun:state", undefined) });
  /*
   * A project can be made without this flow — from an MCP client, from
   * the Workspaces screen in a second window, by an agent attaching a
   * repository — and the moment one exists first run is over. The gate
   * listens for the push that every one of those emits rather than
   * relying on the flow itself to say so, which is the same reason the
   * answer is derived in the main process instead of stored.
   */
  useInvalidateOnPush("config:changed", firstRunKey);
  const { pathname } = useLocation();

  /**
   * Where the window was when an exit was taken, and **why the gate
   * waits for the address to move on from it.**
   *
   * Both exits navigate and then say they have left, in that order. A
   * router's own location update is a transition (see `HashRouter`,
   * which wraps its `setState` in one), so the two can reach the screen
   * in either order — and on a slow machine they do. Opened on "an exit
   * was taken" alone, the gate could draw the window against the address
   * it had *before* the navigation: during first run that is `/`, which
   * the frame sends to `/chat` with a replacing redirect, and the
   * replace lands on the entry the exit had just pushed — the board the
   * person asked for, swapped for the conversation behind their back
   * (EO-529, seen in CI as a first run that never reached its board).
   *
   * So the gate opens once the address is no longer the one the exit was
   * taken from. Still set in a transition, so it lands with the
   * navigation it belongs to. An exit that went nowhere is not stranded
   * either: `firstRun:finish` answering makes `done` true, and that
   * opens the gate on its own.
   */
  const [leftFrom, setLeftFrom] = useState<string | null>(null);
  const left = leftFrom !== null && pathname !== leftFrom;

  /**
   * **And why the flow stays up while the router is behind the window's
   * address, whatever `done` says.**
   *
   * The exit's navigation and the gate's `leftFrom` are both
   * transitions, and a transition can be held back — the board it draws
   * suspends while its code loads. `firstRun:finish` answering is not one:
   * the refetched `done: true` arrives as an urgent update and is drawn
   * at once, against the address the router last *drew*, which is still
   * `/`. The window then opened at `/`, the frame replaced it with
   * `/chat`, and the replace landed on the board's entry — the same
   * symptom as before, by a second road (seen again in CI after EO-529).
   *
   * The history object the router navigates with has the new address
   * the moment the exit pushes it. So once the flow has been drawn, the
   * window is let through only when the address drawn is the address the
   * window is at. An exit that went nowhere leaves the two equal, and is
   * not held. After the window is through, the flow is never brought
   * back this way: every later navigation is behind for a moment too.
   */
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const routerBehind = (requestedPathname(navigator) ?? pathname) !== pathname;
  const flowDrawn = useRef(false);

  // A definite "no", never a missing answer: a window that could not ask
  // must not hide somebody's board behind a welcome screen.
  const inFlow = !left && state.data?.done === false;
  const drawFlow = !state.isLoading && ((inFlow && !pathname.startsWith("/items/")) || (flowDrawn.current && routerBehind));
  // Noted once drawn rather than while rendering: a render React throws
  // away must not decide what the next one holds back.
  useEffect(() => {
    flowDrawn.current = drawFlow;
  });

  if (state.isLoading) return null;
  if (drawFlow) return <FirstRun onLeft={() => startTransition(() => setLeftFrom(pathname))} />;
  return <>{children}</>;
}

/**
 * The path the router has been asked for: its history's own location,
 * which a push changes at once, before the router draws it. Undefined for
 * a navigator that keeps none.
 */
function requestedPathname(navigator: Navigator): string | undefined {
  const location: unknown = (navigator as Navigator & { location?: unknown }).location;
  if (typeof location !== "object" || location === null || !("pathname" in location)) return undefined;
  return typeof location.pathname === "string" ? location.pathname : undefined;
}
