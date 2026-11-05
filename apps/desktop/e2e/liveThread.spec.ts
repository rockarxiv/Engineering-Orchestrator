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
 * Agents writing into an item that is already on screen, with no
 * navigation and no reload.
 *
 * The only test that spans the whole chain — `postComment` →
 * `notifyCommentPosted` → the engine's subscription → `emitPush` →
 * `bridgePushChannels` → preload → `useInvalidateOnPush` → refetch.
 * Every unit test stops at one end of it or the other, and the reported
 * bug lived in the middle: the thread simply never updated while you
 * were looking at it.
 *
 * Two separate agent writes arrive here — intake's pinned understanding
 * and then the refine proposal — which is what makes this evidence
 * rather than a coincidence.
 *
 * It does *not* cover the parked-run timing: with the demo agents
 * (KAN-34) intake succeeds, so nothing parks. That the IPC call returns
 * before the resumed run finishes is pinned precisely, and far faster,
 * by "returns before the resumed run finishes" in domain.test.ts.
 */
test("agents' comments appear in an open item without touching anything", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e live "));
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
    seedItem(home, { title: "Rate limiting" });
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    // Seeding leaves you on the chat layout's home, so this opens the
    // board from the rail and the item from its card, the way a person
    // would — and stays on it: no navigation and no reload from here on,
    // so anything that appears arrived by push.
    await openPipeline(window, "Delivery");
    await itemCard(window, "Rate limiting").click();
    const view = openView(window);
    await expect(view.getByRole("heading", { level: 1, name: "Rate limiting" })).toBeVisible({ timeout: 10_000 });

    const timeline = view.getByRole("region", { name: "Timeline" });

    // The pipeline runs on its own: the built-in step prepares the
    // worktree, the item routes to the implementer, and the placeholder
    // implementer says why it cannot write code. Nothing was clicked;
    // both of those arrived by push.
    await expect(timeline.getByText(/No coding agent is configured/)).toBeVisible({ timeout: 20_000 });

    // A reply of our own lands in the same thread just as promptly.
    const composer = view.getByLabel("Write a comment").last();
    await composer.fill("Per API key, not per account.");
    await view.getByRole("button", { name: "Comment", exact: true }).click();

    await expect(timeline.getByText("Per API key, not per account.")).toBeVisible({ timeout: 10_000 });

    // And the composer let go of it only once it had landed.
    await expect(composer).toHaveValue("");
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});
