import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { attachRepository, closeApp, homeEnv, launchApp } from "./support/app.js";
import { openView } from "./support/board.js";
import { openPipeline } from "./support/rail.js";

/**
 * A pipeline's template chips stay readable beside the conversation
 * (EO-536).
 *
 * The head the board and the Graph view share says where the pipeline
 * came from, that an update was applied lately, and that one is waiting —
 * three chips together, wider than the canvas is beside the conversation
 * at the size the window opens at. Held on one row that would not wrap,
 * they pushed the pipeline's name down to nothing and ran past the
 * canvas's edge. jsdom lays nothing out, so this asks the real window:
 * the name is whole, every chip is inside the canvas, none covers
 * another, and the two that are buttons can be pressed.
 *
 * The states are written into the database before the board is opened,
 * as `seed.ts` writes an item: setup may reach past the UI, and what is
 * under test — the head — reads them through the app's own channel.
 */
test("a pipeline's template origin, applied update and waiting update fit a narrow canvas and can be pressed", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e template origin "));
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

  const { app, window: page } = await launchApp(homeEnv(home));

  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 720));
    await attachRepository(page, repoPath);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1100);

    const pipeline = seedTemplateStates(home);

    await openPipeline(page, pipeline.name);
    const view = openView(page);
    const head = view.locator("header").first();
    await expect(page.getByLabel("Assistant transcript")).toBeVisible();

    const origin = head.getByText(/^From .+ v\d/);
    const updated = head.getByRole("button", { name: /^Updated to v/ });
    const waiting = head.getByRole("button", { name: /^Update waiting: 1 conflict/ });
    await expect(origin).toBeVisible({ timeout: 10_000 });
    await expect(updated).toBeVisible();
    await expect(waiting).toBeVisible();

    // Narrow, which is what this is about: less room than the three chips and the name take on one row.
    const canvas = await view.boundingBox();
    expect(canvas).not.toBeNull();
    const chipsWidth = await head.locator("[data-pipeline-chips]").evaluate((group) => Array.from(group.children, (child) => child.getBoundingClientRect().width).reduce((a, b) => a + b, 0));
    const nameWidth = await head.locator("[data-pipeline-name]").evaluate((name) => name.scrollWidth);
    expect(chipsWidth + nameWidth).toBeGreaterThan(canvas!.width - 48);

    // The name is whole and on one line.
    const name = await head.locator("[data-pipeline-name]").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const lines = new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top)));
      return { text: element.textContent ?? "", width: element.getBoundingClientRect().width, cut: element.scrollWidth > element.clientWidth, lines: lines.size };
    });
    expect(name.text).toBe(pipeline.name);
    expect(name.width).toBeGreaterThan(0);
    expect(name.cut).toBe(false);
    expect(name.lines).toBe(1);

    // Every chip is wholly inside the canvas, and none covers another.
    const boxes = [];
    for (const chip of [origin, updated, waiting]) {
      const box = await chip.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(canvas!.x - 0.5);
      expect(box!.x + box!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width + 0.5);
      await expect(chip).toBeInViewport({ ratio: 1 });
      // Not clipped by the chip's own box: its text is all there.
      expect(await chip.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      boxes.push(box!);
    }
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const apart = a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;
        expect(apart).toBe(true);
      }
    }

    // The buttons are what a press at their middle lands on, and pressing Updated shows the notes.
    for (const button of [updated, waiting]) expect(await topmostAtMiddle(button)).toBe(true);
    await updated.click();
    const notes = page.getByRole("dialog");
    await expect(notes.getByLabel("Release notes")).not.toBeEmpty();
    await notes.getByRole("button", { name: "Close", exact: true }).click();
    await expect(notes).toHaveCount(0);

    // The Graph view's head is the same head, and fits the same way.
    await head.getByRole("navigation", { name: "Pipeline views" }).getByRole("link", { name: "Graph" }).click();
    const graphHead = openView(page).locator("header").first();
    for (const chip of [graphHead.getByText(/^From .+ v\d/), graphHead.getByRole("button", { name: /^Updated to v/ }), graphHead.getByRole("button", { name: /^Update waiting/ })]) {
      await expect(chip).toBeInViewport({ ratio: 1 });
    }
    expect(await graphHead.locator("[data-pipeline-name]").evaluate((element) => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().width > 0)).toBe(true);
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});

/** Whether the element at the middle of this one is it or inside it — what a click there would reach. */
function topmostAtMiddle(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit !== null && (hit === element || element.contains(hit));
  });
}

/**
 * Gives the app's template pipeline an applied update, recent, and a held
 * one with one conflicting key: the three chips together, the widest the
 * head is drawn.
 */
function seedTemplateStates(home: string): { id: string; name: string } {
  const db = new Database(path.join(home, ".config/Electron/eo.db"));
  try {
    const pipeline = db
      .prepare("SELECT id, name, template_slug, template_version, template_base_id FROM pipelines WHERE template_slug IS NOT NULL AND archived_at IS NULL LIMIT 1")
      .get() as { id: string; name: string; template_slug: string; template_version: string; template_base_id: string } | undefined;
    if (!pipeline) throw new Error("seedTemplateStates: the app has no pipeline made from a template");

    const now = Date.now();
    db.prepare("UPDATE pipelines SET template_applied = ? WHERE id = ?").run(JSON.stringify({ version: pipeline.template_version, pipelineVersion: 2, at: now }), pipeline.id);
    db.prepare(
      `INSERT INTO pipeline_update_conflicts (id, pipeline_id, template_slug, from_version, to_version, base_id, template_id, notes, conflicts, problems, created_at, notice_comment_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, '[]')`,
    ).run(
      `0199e536-0000-7000-8000-${now.toString(16).padStart(12, "0").slice(-12)}`,
      pipeline.id,
      pipeline.template_slug,
      pipeline.template_version,
      `${pipeline.template_version}.9`,
      pipeline.template_base_id,
      pipeline.template_base_id,
      "A later version.",
      JSON.stringify([{ key: { kind: "route", fromStepId: "merge_request", resultKey: "opened" }, outcome: "conflict", base: null, current: null, template: null }]),
      now,
    );
    return { id: pipeline.id, name: pipeline.name };
  } finally {
    db.close();
  }
}
