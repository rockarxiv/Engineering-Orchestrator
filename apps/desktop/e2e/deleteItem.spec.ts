import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { itemCard, openView } from "./support/board.js";
import { openPipeline } from "./support/rail.js";
import { seedItem } from "./support/seed.js";
import { attachRepository, closeApp, homeEnv, launchApp } from "./support/app.js";

/**
 * Removing an item from the project, in the real app (KAN-30).
 *
 * `deleteItem` was dead code that could never have run — foreign keys
 * are on and nothing referencing an item cascades — and a unit test on
 * a bare item passed anyway. So this deletes an item that has
 * actually been used: created through the window, with the description
 * sitting in its comment thread, which is precisely the row the old
 * version would have tripped over.
 */
test("a feature can be deleted from the project and does not come back", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e delete "));
  const home = path.join(scratch, "home");
  const repoPath = path.join(scratch, "the repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repoPath, { recursive: true });

  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO E2E");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  git("add", "-A");
  git("commit", "-m", "initial");

  const { app, window } = await launchApp(homeEnv(home));

  try {

    await attachRepository(window, repoPath);
    await expect(window.getByRole("button", { name: "Switch project" })).toContainText("the repo", { timeout: 10_000 });

    // Paused first: new work is dispatched immediately now — the built-in
    // step prepares a worktree and hands straight to the implementer — and
    // deleting an item with a run in flight is a different question,
    // asked and answered further down this file.
    await window.getByRole("button", { name: "Pause agent activity" }).click();
    await expect(window.getByRole("button", { name: "Resume agent activity" })).toBeVisible({ timeout: 10_000 });

    // Seeded rather than typed in: the form that used to create an item
    // is gone, and the two doors that remain (the assistant, Jira) each need a
    // fixture heavier than what this spec is about.
    seedItem(home, { title: "Rate limiting" });
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    // Seeding leaves you on the chat layout's home, so this opens the
    // board from the rail and the item from its card, the way a person would.
    await openPipeline(window, "Delivery");
    await itemCard(window, "Rate limiting").click();
    const view = openView(window);
    await expect(view.getByRole("heading", { level: 1, name: "Rate limiting" })).toBeVisible({ timeout: 10_000 });

    // Asked first, and answering no changes nothing. `exact` because the
    // description comment carries a "Delete comment" button of its own.
    await view.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = window.getByRole("dialog", { name: /^Delete THER-1\?$/ });
    await expect(dialog).toBeVisible();
    // Never mirrored, so there is nothing to offer to delete in Jira.
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Keep it" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(view.getByRole("heading", { level: 1, name: "Rate limiting" })).toBeVisible();

    await view.getByRole("button", { name: "Delete", exact: true }).click();
    // The confirm button names what goes, not which item — the dialog's
    // own heading already carries the key. A story with nothing under it
    // is "this item"; a feature with stories says so instead.
    await window.getByRole("dialog").getByRole("button", { name: "Delete this ticket", exact: true }).click();

    // The view it was showing is gone, so the window goes back to the
    // chat layout's home — and nothing there or on the board names it.
    await expect(view.getByRole("heading", { level: 1, name: "Rate limiting" })).toHaveCount(0, { timeout: 10_000 });
    await openPipeline(window, "Delivery");
    await expect(view.getByLabel(/^Worktree — /)).toBeVisible({ timeout: 10_000 });
    await expect(itemCard(window, "Rate limiting")).toHaveCount(0);

    // Reload: a delete that only removed it from a cache would look
    // exactly the same until now.
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await expect(window.getByRole("button", { name: "Switch project" })).toBeVisible({ timeout: 10_000 });
    await expect(view.getByLabel(/^Worktree — /)).toBeVisible({ timeout: 10_000 });
    await expect(window.getByText("Rate limiting")).toHaveCount(0);
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});
