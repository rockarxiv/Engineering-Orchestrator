import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { itemCard, openView } from "./support/board.js";
import { seedItem } from "./support/seed.js";
import { attachRepository, closeApp, homeEnv, launchApp } from "./support/app.js";
import { openPipeline, openPlace } from "./support/rail.js";

/**
 * Putting an item away and getting it back, in the real app (KAN-33).
 *
 * Archived by hand rather than by the sweep, because the sweep's whole
 * point is a fourteen-day delay and a test cannot wait for one — the
 * rule itself is covered in `archive.test.ts` and `archive.spec` in
 * packages/engine. What this proves is the part unit tests cannot: the
 * migration applies on a real launch, the project stops showing the
 * item, and the archive screen can put it back with everything still
 * attached.
 */
test("an item can be archived and restored, keeping its thread", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e archive "));
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

    // Seeded rather than typed in: the form that used to create an item
    // is gone, and the two doors that remain (the assistant, Jira) each need a
    // fixture heavier than what this spec is about.
    seedItem(home, { title: "Rate limiting", comment: "Cap anonymous callers at 100 requests a minute." });
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    // Seeding leaves you on the chat layout's home, so this opens the
    // board from the rail and the item from its card, the way a person would.
    await openPipeline(window, "Delivery");
    await itemCard(window, "Rate limiting").click();
    const view = openView(window);
    await expect(view.getByRole("heading", { level: 1, name: "Rate limiting" })).toBeVisible({ timeout: 10_000 });

    await view.getByRole("button", { name: "Archive" }).click();

    // Back on the board, without the card and without it being deleted.
    // The columns stay; the card is what leaves. Not pinned to one column:
    // the first step is a built-in that prepares the worktree and hands
    // straight on, so which column a live card sits in is a race this
    // test is not about.
    await expect(view.getByLabel(/^Worktree — /)).toBeVisible({ timeout: 10_000 });
    await expect(view.getByText("Rate limiting")).toHaveCount(0, { timeout: 10_000 });

    await openPlace(window, "Archive");
    await expect(view.getByRole("link", { name: "Rate limiting" })).toBeVisible({ timeout: 10_000 });

    await view.getByRole("button", { name: "Restore" }).click();
    await expect(view.getByText(/Nothing archived yet/)).toBeVisible({ timeout: 10_000 });

    await openPipeline(window, "Delivery");
    await expect(view.getByLabel(/^Worktree — /)).toBeVisible({ timeout: 10_000 });

    // Nothing was deleted, so the opening comment is still there.
    await itemCard(window, "Rate limiting").click();
    await expect(view.getByText("Cap anonymous callers at 100 requests a minute.")).toBeVisible({ timeout: 10_000 });
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});
