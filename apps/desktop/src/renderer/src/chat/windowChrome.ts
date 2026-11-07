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
 * rail's top inset on macOS. What the row does about that is here:
 *
 * - **Drag.** Its empty parts carry `app-drag` (`packages/ui/src/styles.css`),
 *   which moves the window and leaves every control in it pressable.
 * - **Room for the controls.** `CONTROLS_END` and `CONTROLS_HEIGHT`, from
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

/** How tall the window controls are: the overlay's height, 0 without one. */
export const CONTROLS_HEIGHT = "env(titlebar-area-height, 0px)";

export const windowStateKey = ["window:state"] as const;

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
