import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { attachRepository, closeApp, homeEnv, launchApp } from "./support/app.js";
import { openView } from "./support/board.js";
import { openPlace } from "./support/rail.js";

/**
 * The worktrees screen against the real app (G-03).
 *
 * Renderer unit tests stub the IPC bridge, which is exactly what let a
 * broken preload and a page full of dead Tailwind classes ship green
 * before. This drives the actual Electron process: real IPC, real git,
 * a real directory that really disappears.
 *
 * HOME is redirected to a scratch dir so both the database (userData)
 * and the worktree root (~/.eo/worktrees) land there instead of in the
 * developer's own.
 */
test("a held worktree is listed with its size and can be released, keeping the branch", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e worktrees "));
  const home = path.join(scratch, "home");
  const repoPath = path.join(scratch, "the repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repoPath, { recursive: true });

  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO E2E");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  git("add", "-A");
  git("commit", "-m", "initial");

  // Exactly what a dispatch leaves behind: ~/.eo/worktrees/<KEY> on eo/<KEY>.
  const worktreePath = path.join(home, ".eo", "worktrees", "EO-1");
  git("worktree", "add", worktreePath, "-b", "eo/EO-1", "main");
  expect(existsSync(worktreePath)).toBe(true);

  const { app, window: mainWindow } = await launchApp(homeEnv(home));

  try {

    // Point EO at the repo, the way a user would: first run creates a
    // repository from the project (D-04 replaced the single global repo).
    await attachRepository(mainWindow, repoPath);
    await expect(mainWindow.getByRole("button", { name: "Switch project" })).toContainText("the repo", { timeout: 10_000 });

    await openPlace(mainWindow, "Settings");
    // Settings shows one section at a time behind a nav.
    const view = openView(mainWindow);
    await view.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Git & worktrees" }).click();

    const worktrees = view.getByRole("region", { name: "Worktrees" });
    await expect(worktrees.getByText("EO-1")).toBeVisible({ timeout: 10_000 });
    // A real checkout of a real repo, sized by walking it — not a stub.
    await expect(worktrees.getByText(/across 1 checkout/)).toBeVisible();
    // The item was never created, and saying so beats an empty cell.
    await expect(worktrees.getByText("no ticket")).toBeVisible();

    await worktrees.getByRole("button", { name: "Release" }).click();

    await expect(worktrees.getByText("Nothing is held right now.")).toBeVisible({ timeout: 10_000 });
    expect(existsSync(worktreePath), "the directory is really gone").toBe(false);
    // The commits are the deliverable and outlive the checkout.
    expect(git("branch", "--list", "eo/EO-1")).toContain("eo/EO-1");
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});
