import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { attachRepository, closeApp, homeEnv, launchApp } from "./support/app.js";
import { openView } from "./support/board.js";
import { openPlace } from "./support/rail.js";

function makeRepo(root: string, name: string): string {
  const repoPath = path.join(root, name);
  mkdirSync(repoPath, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO E2E");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(repoPath, "README.md"), `# ${name}\n`);
  git("add", "-A");
  git("commit", "-m", "initial");
  return repoPath;
}

/**
 * Several repositories on one project, in the real app (EO-603).
 *
 * Unit tests drive the commands directly; this drives the window — the
 * two screens a repository is added from, that neither makes a project or
 * moves the window, and that each project's worktrees are its own.
 */
test("repositories join the project they are added to, and the window stays where it is", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e repositories "));
  const home = path.join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const apiRepo = makeRepo(scratch, "the api");
  const webRepo = makeRepo(scratch, "the web");
  const docsRepo = makeRepo(scratch, "the docs");

  // A worktree in two repos, made before launch: the app caches its
  // listing per repository, and creating them behind its back mid-test
  // would be testing the cache rather than the scoping.
  execFileSync("git", ["worktree", "add", path.join(home, ".eo", "worktrees", "API-1"), "-b", "eo/API-1", "main"], { cwd: apiRepo });
  execFileSync("git", ["worktree", "add", path.join(home, ".eo", "worktrees", "DOCS-1"), "-b", "eo/DOCS-1", "main"], { cwd: docsRepo });

  const { app, window } = await launchApp(homeEnv(home));

  try {
    // First run: nothing to join, so a project is made, named after it.
    await attachRepository(window, apiRepo);
    const switcher = window.getByRole("button", { name: "Switch project" });
    await expect(switcher).toContainText("the api", { timeout: 10_000 });

    // A second repository, added from Settings → Workspaces. The Add flow
    // asks the kind first and opens on the git one, which is why there is
    // nothing to choose before the repository's own fields.
    const view = openView(window);
    const settingsNav = view.getByRole("navigation", { name: "Settings sections" });
    await openPlace(window, "Settings");
    await settingsNav.getByRole("button", { name: "Workspaces" }).click();
    const workspaces = view.getByRole("region", { name: "Workspaces" });
    await workspaces.getByRole("button", { name: "Add a workspace" }).click();
    const editor = view.getByRole("region", { name: "Add workspace" });
    await editor.getByLabel("Name").fill("the web");
    await editor.getByLabel("Repository path").fill(webRepo);
    await editor.getByRole("button", { name: "Save" }).click();

    // It joined the project on screen: both are listed, and the window
    // has not moved.
    await expect(workspaces.getByText("the web", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(workspaces.getByText("the api", { exact: true })).toBeVisible();
    await expect(switcher).toContainText("the api");

    // A second project, and a repository added to it from Settings →
    // Projects while the window stays on the first.
    await settingsNav.getByRole("button", { name: "Projects" }).click();
    await view.getByRole("button", { name: "Add a project", exact: true }).click();
    const addProject = view.getByRole("region", { name: "Add project" });
    await addProject.getByLabel("Name").fill("Docs");
    await addProject.getByLabel("Key prefix").fill("DOCS");
    await addProject.getByRole("button", { name: "Create" }).click();

    await view.getByRole("button", { name: "Add a repository to Docs" }).click();
    const form = view.getByRole("group", { name: "Add a repository to Docs" });
    await form.getByLabel("Name").fill("the docs");
    await form.getByLabel("Repository path").fill(docsRepo);
    await form.getByRole("button", { name: "Save" }).click();

    await expect(view.getByRole("button", { name: "Remove the docs from Docs" })).toBeVisible({ timeout: 10_000 });
    await expect(switcher).toContainText("the api");

    // Each project's worktrees are its own.
    const worktrees = view.getByRole("region", { name: "Worktrees" });
    await settingsNav.getByRole("button", { name: "Git & worktrees" }).click();
    await expect(worktrees.getByText("API-1")).toBeVisible({ timeout: 10_000 });
    await expect(worktrees.getByText("DOCS-1")).toHaveCount(0);

    // Switching shows the other project's, and only the other's.
    await switcher.click();
    // Scoped to the switcher's own menu: Settings also has buttons named
    // after each repository, for putting them on and off projects.
    await window.getByRole("dialog", { name: "Projects" }).getByRole("button", { name: /Docs/ }).click();
    await expect(worktrees.getByText("DOCS-1")).toBeVisible({ timeout: 10_000 });
    await expect(worktrees.getByText("API-1")).toHaveCount(0);

    // And the switch persists across a relaunch.
    await closeApp(app);
    const { app: relaunched, window: second } = await launchApp(homeEnv(home));
    await expect(second.getByRole("button", { name: "Switch project" })).toContainText("Docs", { timeout: 10_000 });
    await closeApp(relaunched);
  } finally {
    await closeApp(app); // may already be closed on the happy path, where the relaunch is the point
    rmSync(scratch, { recursive: true, force: true });
  }
});
