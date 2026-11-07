import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { machineAvailable } from "../ipc/bridge";
import { isDebugWindow } from "../debug/debugMode";
import { ipcQuery } from "../query/client";
import { useInvalidateOnPush } from "../query/useInvalidateOnPush";
import { isCanvasWindow } from "./canvasPopOut";
import { paletteOf, titleBarColours, useThemeChoice } from "./theme";

/**
 * The main window's own title bar (EO-668, ARCHITECTURE.md, "Window chrome").
 *
 * The desktop's main window draws no native title bar: its top row is the
 * title bar, with the system's window controls drawn over it — Electron's
 * overlay at the top right on Windows and Linux, the traffic lights in the
 * rail's top inset on macOS. On Linux the overlay follows the desktop's own
 * button layout (Electron 43 on), so its controls may be at the top left
 * instead, or at both ends. What the row does about that is here:
 *
 * - **Drag.** Its empty parts carry `app-drag` (`packages/ui/src/styles.css`),
 *   which moves the window and leaves every control in it pressable.
 * - **Room for the controls.** `CONTROLS_START`, `CONTROLS_END` and `CONTROLS_HEIGHT`, from
 *   the overlay's own `env(titlebar-area-*)`, which are absent — and so
 *   zero — wherever there is no overlay: macOS, a browser, the canvas's
 *   and the debug window's native frames.
 * - **Full screen**, where there are no controls and nothing to drag, so
 *   none of it is drawn (`useTitleBar`).
 * - **The controls' colours**, which follow the chat theme
 *   (`useTitleBarColours`).
 */

/**
 * The width the window controls take at the top right: the window's width
 * past the end of the title bar area. Zero with no overlay, and in full
 * screen, where the area is the whole width.
 */
export const CONTROLS_END = "(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))";

/**
 * The width the window controls take at the top left: where the title bar
 * area starts. Zero with no overlay, in full screen, and wherever the
 * controls are all at the right — everywhere but a Linux desktop whose
 * button layout puts some at the left (GNOME's `button-layout`, a
 * right-to-left locale), which Electron honours from 43 on.
 */
export const CONTROLS_START = "env(titlebar-area-x, 0px)";

/** How tall the window controls are: the overlay's height, 0 without one. */
export const CONTROLS_HEIGHT = "env(titlebar-area-height, 0px)";

export const windowStateKey = ["window:state"] as const;

/** Where the window controls are, as the bottom-left corner of their box at the top right; see `windowControlsBox`. */
export interface WindowControlsBox {
  left: number;
  bottom: number;
}

/**
 * Where the window controls are drawn over the page, by the overlay's own
 * account, or null where none are: macOS, a browser, a window with a
 * native frame, and full screen — where Linux still reports the overlay's
 * height but its width is gone.
 *
 * For what is placed by script rather than laid out, and so cannot leave
 * room with `env()`: the tour's callout (EO-667).
 */
export function windowControlsBox(): WindowControlsBox | null {
  const overlay = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay;
  if (!overlay?.visible) return null;
  const area = overlay.getTitlebarAreaRect();
  const left = area.x + area.width;
  return left < window.innerWidth && area.height > 0 ? { left, bottom: area.height } : null;
}

/**
 * Whether this page is the main window on a desktop — the one window with
 * no native title bar. Not a browser tab served the same renderer, and
 * neither of the two windows that keep their frames.
 */
function isMainWindow(): boolean {
  return machineAvailable() && !isCanvasWindow() && !isDebugWindow();
}

/**
 * Whether the top row is this window's title bar right now: the desktop's
 * main window, and not full screen.
 *
 * What decides the inset that is a fixed size rather than the overlay's —
 * the rail's room for the traffic lights — and whether a strip that exists
 * only to be dragged is drawn at all. Full screen is asked of the main
 * process rather than read off `env()`: on Linux the overlay still reports
 * its height there.
 */
export function useTitleBar(): boolean {
  const main = isMainWindow();
  useInvalidateOnPush("window:changed", windowStateKey, main);
  const state = useQuery({ queryKey: windowStateKey, queryFn: () => ipcQuery("window:state", undefined), enabled: main });
  return main && state.data?.fullScreen !== true;
}

/**
 * Keeps the window controls' colours on the chat theme (EO-668).
 *
 * `under` is what the top row is at the window's right edge, which is
 * what the controls are drawn over. Sent again whenever either changes —
 * a theme picked in Settings recolours the controls without a restart.
 * macOS answers that it has nothing to colour, which is true.
 */
export function useTitleBarColours(under: "deep" | "canvas"): void {
  const choice = useThemeChoice();
  useEffect(() => {
    if (!isMainWindow()) return;
    const colours = titleBarColours(paletteOf(choice), under);
    if (colours !== null) void ipcQuery("window:titleBar", colours).catch(() => {});
  }, [choice, under]);
}
