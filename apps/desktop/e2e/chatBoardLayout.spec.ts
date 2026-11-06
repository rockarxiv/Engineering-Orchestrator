import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { attachRepository, closeApp, homeEnv, launchApp, sizeWindow } from "./support/app.js";
import { itemCard, openView } from "./support/board.js";
import { openPipeline, openPlace } from "./support/rail.js";
import { seedItem } from "./support/seed.js";

/**
 * A long board stays usable (EO-634).
 *
 * Every column used to be as tall as the tallest, and the columns' wrapper
 * as tall as that, so the canvas scrolled the whole board up and down and
 * its sideways scrollbar sat under the last card of the longest column.
 * Now each column is as tall as its own cards, the columns scroll both
 * ways as one inside what the board's head leaves of the canvas, and the
 * head stays put. jsdom lays nothing out, so this measures the real window.
 */

/**
 * Two steps a person owns, added to the default pipeline, so seeded cards
 * stay where they are put: nothing runs on them and nothing routes out.
 * The shipped pipeline has only "Done" that a run never picks up.
 */
function addQuietSteps(home: string): { id: string; name: string }[] {
  const db = new Database(path.join(home, ".config/Electron/eo.db"));
  try {
    const pipeline = db.prepare("SELECT id FROM pipelines WHERE entry_step_id IS NOT NULL LIMIT 1").get() as { id: string } | undefined;
    if (!pipeline) throw new Error("addQuietSteps: the app has no pipeline yet");
    const steps = [
      { id: "waiting", name: "Waiting", position: 20 },
      { id: "parked", name: "Parked", position: 21 },
    ];
    for (const step of steps) {
      db.prepare(
        `INSERT INTO pipeline_steps (id, pipeline_id, position, name, type, owner_role, entry_action, instructions_summary, is_terminal, plan_mode, off_board)
         VALUES (?, ?, ?, ?, 'user', NULL, NULL, NULL, 0, 0, 0)`,
      ).run(step.id, pipeline.id, step.position, step.name);
    }
    return steps;
  } finally {
    db.close();
  }
}

/** A column of the open board, by its step's name. */
function columnOf(view: Locator, name: string): Locator {
  return view.getByRole("region", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — `) });
}

/** How a scroller's content compares with its box. */
function extent(locator: Locator) {
  return locator.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    scrollTop: node.scrollTop,
  }));
}

async function openBoard(page: Page) {
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await openPipeline(page, "Delivery");
  await expect(openView(page).getByRole("group", { name: "Columns" })).toBeVisible({ timeout: 10_000 });
}

test("a long board: columns as tall as their cards, scrolling as one under a head that stays", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e chat board layout "));
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
    await sizeWindow(app, page, 1100, 720);
    await attachRepository(page, repoPath);
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(720);

    const [short, long] = addQuietSteps(home);
    if (!short || !long) throw new Error("addQuietSteps added no steps");

    // One card on one step, four on another.
    seedItem(home, { title: "Alone here", stepId: short.id });
    for (let index = 0; index < 4; index += 1) seedItem(home, { title: `Queued ${index}`, stepId: long.id });
    await openBoard(page);
    const view = openView(page);
    const columns = view.getByRole("group", { name: "Columns" });
    await expect(columnOf(view, long.name).getByRole("button", { name: /^Open / })).toHaveCount(4);

    const one = (await columnOf(view, short.name).boundingBox())!;
    const four = (await columnOf(view, long.name).boundingBox())!;
    expect(one.height).toBeLessThan(four.height);

    // Eight more on the long step, all shown: taller than the window, and
    // the pipeline's columns wider than the canvas beside the conversation.
    for (let index = 4; index < 12; index += 1) seedItem(home, { title: `Queued ${index}`, stepId: long.id });
    await openBoard(page);
    const longColumn = columnOf(view, long.name);
    await longColumn.getByRole("button", { name: "Show 4 more" }).click();
    await longColumn.getByRole("button", { name: "Show 4 more" }).click();
    await expect(longColumn.getByRole("button", { name: /^Open / })).toHaveCount(12);
    await expect(longColumn.getByRole("button", { name: /^Show \d+ more$/ })).toHaveCount(0);
    expect((await longColumn.boundingBox())!.height).toBeGreaterThan(720);

    const box = (await columns.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(720);
    const area = await extent(columns);
    expect(area.scrollWidth).toBeGreaterThan(area.clientWidth);
    expect(area.scrollHeight).toBeGreaterThan(area.clientHeight);
    const panel = await extent(view);
    expect(panel.scrollHeight).toBe(panel.clientHeight);

    // To the foot of the columns, and the head is still there.
    await columns.evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
    await expect.poll(async () => (await extent(columns)).scrollTop).toBeGreaterThan(0);
    const filter = (await view.getByRole("searchbox", { name: "Filter the board" }).boundingBox())!;
    expect(filter.y).toBeGreaterThanOrEqual(0);
    expect(filter.y + filter.height).toBeLessThanOrEqual(720);
    expect(filter.x + filter.width).toBeLessThanOrEqual(1100);

    // A short canvas: the columns keep about two cards' height, and the canvas scrolls to them.
    await sizeWindow(app, page, 1100, 380);
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(380);
    const squeezed = await extent(columns);
    expect(squeezed.clientHeight).toBeGreaterThanOrEqual(190);
    await expect.poll(async () => {
      const shortPanel = await extent(view);
      return shortPanel.scrollHeight > shortPanel.clientHeight;
    }).toBe(true);

    // Every other view scrolls in the canvas as it did: an item's page…
    await sizeWindow(app, page, 1100, 720);
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(720);
    const long_comment = Array.from({ length: 60 }, (_, line) => `Line ${line} of a long note.`).join("\n\n");
    seedItem(home, { title: "A long read", stepId: short.id, comment: long_comment });
    await openBoard(page);
    await itemCard(page, "A long read").click();
    await expect(view.getByRole("heading", { level: 1, name: "A long read" })).toBeVisible({ timeout: 10_000 });
    await expect(view.getByText("Line 59 of a long note.")).toBeAttached({ timeout: 10_000 });
    await scrollsTheCanvas(view);

    // …and Settings.
    await openPlace(page, "Settings");
    await expect(view.getByRole("navigation", { name: "Settings sections" })).toBeVisible({ timeout: 10_000 });
    await scrollsTheCanvas(view);
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});

/** The canvas's own panel is what scrolls this view up and down. */
async function scrollsTheCanvas(view: Locator) {
  await expect.poll(async () => {
    const panel = await extent(view);
    return panel.scrollHeight > panel.clientHeight;
  }).toBe(true);
  await view.evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
  await expect.poll(async () => (await extent(view)).scrollTop).toBeGreaterThan(0);
}
