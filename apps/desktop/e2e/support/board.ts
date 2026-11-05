// The page type `electron.launch(...).firstWindow()` hands back.
import type { Page } from "playwright";

/**
 * Opens an item from the project board, the way a person does.
 *
 * A card is not a block of clickable text. Its whole face is one control —
 * a single button, absolutely positioned over the card, that owns both the
 * click that opens it and the drag that moves it — and the body above it
 * is `pointer-events-none` so that button keeps receiving both. A person
 * aiming at the title therefore hits the button, which is exactly what
 * they meant.
 *
 * Playwright does not resolve it that way. `getByText(title).click()`
 * finds the `<h3>`, hit-tests its centre, sees the button underneath, and
 * refuses on the grounds that something else would receive the click —
 * then retries until the test times out. Three specs clicked the title
 * text and hung for thirty seconds each once the card gained its overlay.
 *
 * So the specs ask for the control by name instead. The card labels it
 * `Open <KEY>: <title>`; matching on the title alone keeps a spec that
 * does not otherwise care about the key from having to know it.
 *
 * Looked for in the open view, which is where the chat layout draws a
 * board — beside the conversation, whose own references to an item are
 * not the card.
 */
export function itemCard(page: Page, title: string) {
  return openView(page)
    .getByRole("button", { name: new RegExp(`^Open .+: ${escapeForRegExp(title)}$`) })
    .first();
}

/**
 * What the chat layout has open beside the conversation: a board, an
 * item, Settings. One at a time, whichever tab is current.
 */
export function openView(page: Page) {
  return page.getByRole("tabpanel", { name: "Open view" });
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
