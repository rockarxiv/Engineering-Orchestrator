import { useEffect, useSyncExternalStore } from "react";
import { isCanvasWindowSearch, type CanvasTabs } from "@eo/core";
import { bridge, machineAvailable } from "../ipc/bridge";
import { ipcQuery } from "../query/client";

/**
 * The canvas in a window of its own (EO-383): what a renderer knows
 * about it.
 *
 * Two windows load this bundle while the canvas is popped out. The main
 * one draws the conversation at full width and sends every view it is
 * asked to open across to the other; the other draws the canvas and
 * nothing else (`CanvasWindow.tsx`). This is how each knows which it is
 * and what the other is doing.
 */

/**
 * Whether this renderer *is* the popped-out canvas.
 *
 * Read off the URL's query rather than the route, because the route is
 * the view the canvas is showing and changes with every tab. See
 * `CANVAS_WINDOW_SEARCH`. Fixed for the life of the window.
 */
export function isCanvasWindow(): boolean {
  return typeof window !== "undefined" && isCanvasWindowSearch(window.location.search);
}

/**
 * Whether EO can open a window here at all: a desktop can, a browser
 * served the same renderer cannot, and is offered no button for it.
 */
export function canPopOutCanvas(): boolean {
  return machineAvailable();
}

interface CanvasWindowState {
  /** The canvas is in its own window, so this one draws no canvas. */
  poppedOut: boolean;
  /** Tabs a "Pop in" handed back, until the frame has taken them. */
  restore: CanvasTabs | null;
}

const NOT_POPPED_OUT: CanvasWindowState = { poppedOut: false, restore: null };

// A module's state rather than a component's, because two things in the
// main window read it and they are far apart: the frame, which decides
// where a view opens, and `ViewPublisher`, which keeps quiet while the
// other window is the one showing something.
let state = NOT_POPPED_OUT;
const listeners = new Set<() => void>();

function set(next: CanvasWindowState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the canvas is popped out, and anything a pop-in handed back. */
export function useCanvasWindowState(): CanvasWindowState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => NOT_POPPED_OUT,
  );
}

/** Says the canvas is (or is not) popped out, from the window that just made it so. */
export function setCanvasPoppedOut(poppedOut: boolean): void {
  if (state.poppedOut !== poppedOut) set({ poppedOut, restore: null });
}

/** The frame has taken the tabs a pop-in handed back. */
export function clearCanvasRestore(): void {
  if (state.restore !== null) set({ ...state, restore: null });
}

/**
 * Keeps the state above true, for as long as the main window's frame is
 * mounted: asks once, then listens.
 *
 * Mounted by the frame rather than started with the module, so that a
 * window which never draws the chat layout never asks.
 */
export function useCanvasWindowSync(): void {
  useEffect(() => {
    if (!canPopOutCanvas()) return;
    let heard = false;
    const stop = bridge().subscribe("canvas:changed", (change) => {
      heard = true;
      set({ poppedOut: change.poppedOut, restore: change.restore });
    });
    // What was true before this window was listening — a main window
    // reloaded while the canvas is out. A push that arrived first is
    // newer than this answer and wins.
    void ipcQuery("canvas:state", undefined)
      .then((answer) => {
        if (!heard) setCanvasPoppedOut(answer.poppedOut === true);
      })
      .catch(() => {});
    return () => {
      stop();
      set(NOT_POPPED_OUT);
    };
  }, []);
}
