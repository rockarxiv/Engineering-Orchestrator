import type { CanvasTabs, IpcPayload, IpcResponse } from "@eo/core";
import type { Platform } from "./platform.js";
import { emitPush } from "./push.js";

/**
 * The canvas, popped out into a window of its own and back (EO-383).
 *
 * The canvas is the tabbed panel beside the conversation in the chat
 * layout. In the main window it narrows the chat every time a board or
 * an item is opened; popped out, it is a second window and the chat
 * keeps its width. The window itself is the platform's
 * (`platform/electron.ts`, the one file that may say `new
 * BrowserWindow`). What is here is the little that has to travel
 * *between* two renderers that share no memory:
 *
 * - **What the canvas window opens with.** It is a fresh renderer and
 *   holds nothing, so the tabs it was popped out with wait here until it
 *   asks (`canvas:state`).
 * - **What a "Pop in" hands back.** The window says which tabs it has
 *   and is then closed; the main window is told once the window is
 *   really gone, in the same push that says the canvas is no longer out.
 *
 * In memory and not a table, for `currentView.ts`'s reason: this is how
 * one person's windows are arranged right now, true until one of them
 * closes, and a stored copy would describe a window that no longer
 * exists.
 */

/** The tabs the canvas window opens with, while there is one. */
let carried: CanvasTabs | null = null;

/** The tabs a "Pop in" is handing back, between the request and the window closing. */
let restoring: CanvasTabs | null = null;

/** Forgets everything. For tests. */
export function resetCanvasWindow(): void {
  carried = null;
  restoring = null;
}

/** "Pop out": the canvas in its own window, with these tabs. */
export function popOutCanvas(platform: Platform, input: IpcPayload<"canvas:window">): IpcResponse<"canvas:window"> {
  // Recorded before the window is asked for, because a window that
  // opens asks for these as soon as it has loaded.
  const before = carried;
  carried = input;
  if (!platform.openCanvas(input.active)) {
    // No screen to put it on. The canvas stays where it was, and the
    // caller is told so rather than left assuming.
    carried = before;
    return { opened: false };
  }
  restoring = null;
  emitPush("canvas:changed", { poppedOut: true, restore: null });
  return { opened: true };
}

/**
 * Opens an address as a tab in the popped-out canvas.
 *
 * Remembered as well as pushed: a window still loading hears no push,
 * and finds this in what `canvas:state` answers when it has.
 */
export function openInCanvas(platform: Platform, input: IpcPayload<"canvas:open">): IpcResponse<"canvas:open"> {
  if (!platform.hasCanvas()) return { opened: false };
  carried = { tabs: [...(carried?.tabs ?? []).filter((path) => path !== input.path), input.path], active: input.path };
  // Raised, so that what was just opened is in front of the person who
  // opened it rather than behind the window they clicked in.
  platform.openCanvas(input.path);
  emitPush("canvas:opened", { path: input.path });
  return { opened: true };
}

/**
 * Closes the canvas window: "Pop in" with tabs to restore, "Close the
 * canvas" without.
 *
 * The main window is not told here. It is told by `canvasWindowClosed`,
 * once the window is gone — the one path every way of closing it takes.
 */
export function closeCanvas(platform: Platform, input: IpcPayload<"canvas:close">): IpcResponse<"canvas:close"> {
  if (!platform.hasCanvas()) return { closed: false };
  restoring = input.restore;
  // Popping in is going back to the main window, so it comes forward.
  if (input.restore !== null) platform.showWindow();
  platform.closeCanvas();
  return { closed: true };
}

/**
 * Hands the person from the canvas window to the conversation (EO-408).
 *
 * A view in the canvas can ask for the composer — "ask for a change" on a
 * proposed item — and popped out, the composer is in the other window.
 * So the main window comes forward, as it does for a pop-in, and is told
 * to put the cursor in its box. Nothing when there is no canvas window:
 * beside the conversation the view reaches the composer itself.
 */
export function askFromCanvas(platform: Platform): IpcResponse<"canvas:ask"> {
  if (!platform.hasCanvas()) return { handed: false };
  platform.showWindow();
  emitPush("canvas:asked", {});
  return { handed: true };
}

/** Whether the canvas is out, and what its window opens with. */
export function canvasState(platform: Platform): IpcResponse<"canvas:state"> {
  if (!platform.hasCanvas() || carried === null) return { poppedOut: platform.hasCanvas(), tabs: [], active: null };
  return { poppedOut: true, tabs: carried.tabs, active: carried.active };
}

/**
 * The canvas window has gone — by "Pop in", by "Close the canvas", or by
 * the window's own close button.
 *
 * Called by the platform from the window's `closed`, which is the only
 * place all three meet. Says so to the main window, with the tabs to
 * restore when it was a pop-in and null when it was a close: closing the
 * window closes the canvas, and the main window stays on the
 * conversation alone.
 */
export function canvasWindowClosed(): void {
  const restore = restoring;
  carried = null;
  restoring = null;
  emitPush("canvas:changed", { poppedOut: false, restore });
}
