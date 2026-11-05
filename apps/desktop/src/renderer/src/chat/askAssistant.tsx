import { createContext, useContext } from "react";

/**
 * Hands the person to the conversation from a view: opens the column if
 * it is folded and puts the cursor in its box.
 *
 * The chat layout has one place to talk to an agent, and this is how a
 * screen that used to have its own (the board's planning with the
 * product owner, the pipeline editor's architect) points at it instead.
 * With the canvas popped out into its own window the conversation is in
 * the other one, and the hand-off brings that window forward with the
 * cursor in its box (`CanvasWindow.tsx`, `canvas:ask`).
 *
 * The assistant reads the screen itself (`view:current`), so a view says
 * nothing here about where the person is.
 */
export type AskAssistant = () => void;

export const AskAssistantContext = createContext<AskAssistant | null>(null);

/** The hand-off, or null outside the chat layout's frame (a view rendered on its own in a test). */
export function useAskAssistant(): AskAssistant | null {
  return useContext(AskAssistantContext);
}
