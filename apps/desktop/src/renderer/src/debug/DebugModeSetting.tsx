import { useDebugMode, useSetDebugMode } from "./debugMode";

/** What the switch is called, in both Settings screens and in their tests. */
export const DEBUG_MODE_LABEL = "Debug mode";

/** What turning it on does, said once for both Settings screens. */
export const DEBUG_MODE_DESCRIPTION =
  "Records exactly what EO hands each agent's backend — the instructions, the prompt, and the session it was opened with — and opens a window that shows it. " +
  "Off, nothing extra is stored.";

/** What the person needs to know before they rely on it. */
export const DEBUG_MODE_NOTE =
  "While this is on, press F12 to open the debug window. It applies from the next dispatch: a run that started before you turned it on has no record of what it was sent. " +
  "Prompts and instructions are stored in full with the run; secrets never are — servers, tools and skills are listed by name only. " +
  "Turning it off stops recording and keeps what was already recorded.";

/**
 * The debug-mode switch's state and action, for whichever Settings
 * screen is drawing it (EO-392).
 *
 * The two layouts have their own switch components and their own cards,
 * so what they share is this rather than markup: the value, the write,
 * and the words above.
 */
export function useDebugModeSetting(): { enabled: boolean | undefined; saving: boolean; set: (enabled: boolean) => void } {
  const enabled = useDebugMode();
  const save = useSetDebugMode();
  return { enabled, saving: save.isPending, set: (next) => save.mutate(next) };
}
