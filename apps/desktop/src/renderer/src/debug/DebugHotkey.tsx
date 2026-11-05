import { useEffect } from "react";
import { ipcQuery } from "../query/client";
import { useDebugMode } from "./debugMode";

/**
 * F12 opens the debug window — while debug mode is on (EO-392).
 *
 * Renders nothing. Mounted once per window, above the router, so the key
 * works on every screen.
 *
 * **With debug mode off this listens for nothing.** No listener is
 * attached, the key is not swallowed, and F12 does whatever it did
 * before EO had a debug mode. With it on, the key is EO's: the default
 * is prevented and main is asked for the window, which raises the one
 * that is open rather than making a second. Chromium's own devtools
 * stay where they were, on Ctrl/Cmd-Shift-I.
 *
 * In the renderer rather than as an accelerator in the main process,
 * because the main process's windows are built before there is a
 * database to read the setting from, and because here "off" can mean
 * *no handler at all* rather than a handler that looks the setting up
 * and declines.
 */
export function DebugHotkey() {
  const enabled = useDebugMode();

  useEffect(() => {
    if (enabled !== true) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "F12" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      // Nothing to do with a refusal: main says `opened: false` when the
      // setting was switched off a moment ago, and that is the answer.
      void ipcQuery("debug:window", undefined).catch(() => {});
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);

  return null;
}
