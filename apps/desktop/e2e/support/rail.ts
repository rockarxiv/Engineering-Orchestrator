import type { Page } from "playwright";

/**
 * Goes to one of the places behind the chat rail's gear, the way a
 * person does.
 *
 * The chat layout's rail lists the project's pipelines and what is
 * waiting on you; every other place — the items list, the archive,
 * agents, Settings — is a row of the menu "More places" opens, beside
 * who you are (`ChatRail.tsx`, `Footer`). The label is the row's, as the
 * menu draws it (`shared/layout/sidebar.ts`, `places`).
 */
export async function openPlace(window: Page, label: string): Promise<void> {
  const rail = window.getByRole("navigation", { name: "Main" });
  await rail.getByRole("button", { name: "More places" }).click();
  await rail.getByRole("menu", { name: "Places" }).getByRole("menuitem", { name: label, exact: true }).click();
}

/**
 * Opens a pipeline's board from the rail, where the chat layout lists
 * every pipeline the project has by name.
 */
export async function openPipeline(window: Page, name: string): Promise<void> {
  await window.getByRole("navigation", { name: "Main" }).getByRole("link", { name: new RegExp(`^${escapeForRegExp(name)}\\b`) }).click();
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
