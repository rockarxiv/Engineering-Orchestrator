import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { itemCard, openView } from "./support/board.js";
import { openPipeline } from "./support/rail.js";
import { seedItem } from "./support/seed.js";
import { attachRepository, closeApp, homeEnv, launchApp } from "./support/app.js";

/**
 * A step a person decides on, added to the pipeline the app just seeded.
 *
 * Written straight into the database, the way `seedItem` writes an item
 * and `worktrees.spec.ts` cuts a checkout with git: setup is allowed to
 * reach past the UI as long as what is under test does not. What is
 * under test here is the button and the move it causes, not how the
 * step came to be on the pipeline — which is a conversation with the
 * assistant since the pipeline editor went (EO-525).
 *
 * Deliberately *not* the shipped "Done" step, even though that one now
 * declares results too. Approving there is a person signing off work
 * that is already finished, so the item stays where it stands — and the
 * thing this spec has to prove is that pressing a button moves a card.
 */
function seedDecisionStep(home: string): void {
  const db = new Database(path.join(home, ".config/Electron/eo.db"));
  try {
    const pipeline = db.prepare("SELECT id FROM pipelines WHERE entry_step_id IS NOT NULL LIMIT 1").get() as { id: string } | undefined;
    if (!pipeline) throw new Error("seedDecisionStep: the app has no pipeline yet");

    const results = JSON.stringify([
      { key: "approved", label: "Approve", tone: "success", requiresComment: false },
      { key: "send_back", label: "Send back", tone: "warning", requiresComment: true },
    ]);
    db.prepare(
      `INSERT INTO pipeline_steps (id, pipeline_id, position, name, type, owner_role, entry_action, instructions_summary, is_terminal, plan_mode, off_board, results)
       VALUES ('approval', ?, 20, 'Approval', 'user', NULL, NULL, 'Check the Q3 numbers before it is sent.', 0, 0, 0, ?)`,
    ).run(pipeline.id, results);
    db.prepare(
      `INSERT INTO step_routes (id, pipeline_id, from_step_id, result_key, label, tone, target, position)
       VALUES ('r_approval_approved', ?, 'approval', 'approved', 'Approve', 'success', 'ready_to_merge', 0)`,
    ).run(pipeline.id);
    db.prepare(
      `INSERT INTO step_routes (id, pipeline_id, from_step_id, result_key, label, tone, target, position)
       VALUES ('r_approval_send_back', ?, 'approval', 'send_back', 'Send back', 'warning', 'todo', 1)`,
    ).run(pipeline.id);
  } finally {
    db.close();
  }
}

/**
 * Approving, in the real app (EO-310, ARCHITECTURE.md, "The item").
 *
 * The gesture the non-developer product turns on, end to end: the item's
 * own screen offers the step's results as buttons, pressing one takes
 * the route that result is wired to, and the card is in the next column.
 *
 * What unit tests cannot cover is exactly the join being asserted here —
 * that the migration applies on a real launch, that the detail screen
 * receives the step's results over IPC with the destination already
 * resolved, and that the board follows the transition without a reload.
 */
test("a person approves on a human step and the card moves", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e decide "));
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

    seedDecisionStep(home);
    // Parked on the step a person decides on, which is where an item
    // arrives once the draft before it is done. Nothing dispatches it —
    // a `user` step is never dispatched — so it waits for the button.
    // Criteria enough that the page is taller than the window, so the bar has something to stay pinned over.
    seedItem(home, {
      title: "Q3 report",
      stepId: "approval",
      comment: "The draft is attached.",
      acceptanceCriteria: Array.from({ length: 60 }, (_, index) => `Figure ${index + 1} matches the ledger`),
    });
    await window.reload();
    await window.waitForLoadState("domcontentloaded");

    await openPipeline(window, "Delivery");
    await itemCard(window, "Q3 report").click();
    const view = openView(window);
    await expect(view.getByRole("heading", { level: 1, name: "Q3 report" })).toBeVisible({ timeout: 10_000 });

    // The button says where it leads, which is the half of the design a person
    // reads before deciding anything.
    const bar = view.getByRole("region", { name: "Decide" });
    const approve = bar.getByRole("button", { name: "Approve → Done" });
    await expect(approve).toBeVisible({ timeout: 10_000 });
    await expect(bar).toContainText("Check the Q3 numbers before it is sent.");

    // Pinned (EO-826): with the page scrolled to its top, the bar is still on screen.
    await expect.poll(() => view.evaluate((element) => element.scrollHeight > element.clientHeight + 200)).toBe(true);
    await view.evaluate((element) => element.scrollTo(0, 0));
    await expect.poll(() => view.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(bar).toBeInViewport();
    await expect(approve).toBeInViewport();
    const [panel, pinned] = await Promise.all([view.boundingBox(), bar.boundingBox()]);
    expect(pinned!.y + pinned!.height).toBeLessThanOrEqual(panel!.y + panel!.height + 1);

    // The banner under the header leads to it.
    await view.getByRole("button", { name: "Waiting on you: Approval" }).click();
    await expect(bar).toBeFocused();
    await approve.click();

    // The route decided where it went — nothing here named a column.
    await openPipeline(window, "Delivery");
    await expect(view.getByLabel(/^Done — /).getByText("Q3 report")).toBeVisible({ timeout: 10_000 });
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});
