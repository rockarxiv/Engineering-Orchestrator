import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { attachRepository, closeApp, homeEnv, launchApp, sizeWindow } from "./support/app.js";
import { itemCard, openView } from "./support/board.js";
import { openPipeline } from "./support/rail.js";
import { seedItem } from "./support/seed.js";

/**
 * Long offered answers fit their chips, and a click lands on the one under it (EO-722).
 *
 * Each option on the item page is a chip of words over a press target
 * that fills it. The chip used to be a fixed 26px, so a sentence-long
 * option wrapped out of it and over the chip below, whose target was
 * what sat under those lines: clicking the second line of (A) posted
 * (B). jsdom lays nothing out, so this measures the real window.
 */

const LONG_A =
  "(A) Keep the current behaviour and document it in the reference, since changing it now would break every caller that relies on the old order and none of them is tested against the new one.";
const LONG_B = "(B) Change it now and migrate every caller in the same change, accepting the larger diff and the longer review that comes with it.";
const SHORT = "(C) Neither";

/** A step a person owns, so the seeded item stays where it is put: nothing runs on it. */
function addQuietStep(home: string): string {
  const db = new Database(path.join(home, ".config/Electron/eo.db"));
  try {
    const pipeline = db.prepare("SELECT id FROM pipelines WHERE entry_step_id IS NOT NULL LIMIT 1").get() as { id: string } | undefined;
    if (!pipeline) throw new Error("addQuietStep: the app has no pipeline yet");
    db.prepare(
      `INSERT INTO pipeline_steps (id, pipeline_id, position, name, type, owner_role, entry_action, instructions_summary, is_terminal, plan_mode, off_board)
       VALUES ('waiting', ?, 20, 'Waiting', 'user', NULL, NULL, NULL, 0, 0, 0)`,
    ).run(pipeline.id);
    return "waiting";
  } finally {
    db.close();
  }
}

/** An agent's question with the given options, on the item. */
function addQuestion(home: string, itemId: string, options: string[]): string {
  const db = new Database(path.join(home, ".config/Electron/eo.db"));
  try {
    const id = `${itemId}-q`;
    db.prepare(
      `INSERT INTO comments (id, item_id, run_id, author_type, author_id, body, kind, options, parent_id, pinned, created_at)
       VALUES (?, ?, NULL, 'agent', NULL, 'Which way should the order go?', 'question', ?, NULL, 0, ?)`,
    ).run(id, itemId, JSON.stringify(options), Date.now());
    return id;
  } finally {
    db.close();
  }
}

/** The replies filed under a comment, by body. */
function repliesTo(home: string, parentId: string): string[] {
  const db = new Database(path.join(home, ".config/Electron/eo.db"), { readonly: true });
  try {
    return (db.prepare("SELECT body FROM comments WHERE parent_id = ?").all(parentId) as { body: string }[]).map((row) => row.body);
  } finally {
    db.close();
  }
}

interface Chip {
  option: string;
  target: { x: number; y: number; width: number; height: number };
  words: { x: number; y: number; width: number; height: number };
}

/** Each option's press target and the box its words draw in. */
async function measure(answers: Locator, options: string[]): Promise<Chip[]> {
  const chips: Chip[] = [];
  for (const option of options) {
    const target = answers.getByRole("button", { name: option, exact: true });
    // The text itself, measured as a range: the box an element draws can
    // be smaller than the lines that overflow it, which was the bug.
    const words = await target.locator("xpath=..").evaluate((chip) => {
      const range = document.createRange();
      range.selectNodeContents(chip.querySelector("span")!);
      const { x, y, width, height } = range.getBoundingClientRect();
      return { x, y, width, height };
    });
    chips.push({ option, target: (await target.boundingBox())!, words });
  }
  return chips;
}

function overlaps(a: Chip["target"], b: Chip["target"]): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function expectChipsFit(page: Page, answers: Locator) {
  // On screen, so the hit test below has something under the point.
  await answers.scrollIntoViewIfNeeded();
  const chips = await measure(answers, [LONG_A, LONG_B, SHORT]);
  for (const chip of chips) {
    // The target covers every line of the words.
    expect(chip.words.x).toBeGreaterThanOrEqual(chip.target.x - 0.5);
    expect(chip.words.y).toBeGreaterThanOrEqual(chip.target.y - 0.5);
    expect(chip.words.x + chip.words.width).toBeLessThanOrEqual(chip.target.x + chip.target.width + 0.5);
    expect(chip.words.y + chip.words.height).toBeLessThanOrEqual(chip.target.y + chip.target.height + 0.5);
  }
  for (const [index, chip] of chips.entries()) {
    for (const other of chips.slice(index + 1)) expect(overlaps(chip.target, other.target), `${chip.option} overlaps ${other.option}`).toBe(false);
  }
  const [a, , short] = chips;
  // The long one wraps; the short one stays one small-button line.
  expect(a!.target.height).toBeGreaterThan(30);
  expect(Math.round(short!.target.height)).toBe(26);
  // Whatever is under the foot of (A)'s last line is (A)'s own target.
  const foot = { x: a!.words.x + 20, y: a!.words.y + a!.words.height - 4 };
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("aria-label") ?? null, foot);
  expect(hit).toBe(LONG_A);
  return foot;
}

async function resize(app: ElectronApplication, page: Page, width: number) {
  await sizeWindow(app, page, width, 720);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
}

test("long offered answers fit their chips, and a click on any line posts that answer", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e offered answers "));
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
    await resize(app, page, 1100);
    await attachRepository(page, repoPath);

    const stepId = addQuietStep(home);
    const item = seedItem(home, { title: "Ordering", stepId });
    const questionId = addQuestion(home, item.id, [LONG_A, LONG_B, SHORT]);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await openPipeline(page, "Delivery");
    await itemCard(page, "Ordering").click();
    const view = openView(page);
    await expect(view.getByRole("heading", { level: 1, name: "Ordering" })).toBeVisible({ timeout: 10_000 });

    const answers = view.getByLabel("Offered answers");
    if (!(await answers.isVisible())) await view.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(answers.getByRole("button", { name: LONG_A, exact: true })).toBeVisible({ timeout: 10_000 });

    // Two thread widths: the chips fit at each.
    await resize(app, page, 1400);
    await expectChipsFit(page, answers);
    await resize(app, page, 1000);
    const foot = await expectChipsFit(page, answers);

    // A real click on (A)'s last line posts (A), and not (B).
    await page.mouse.click(foot.x, foot.y);
    await expect.poll(() => repliesTo(home, questionId), { timeout: 10_000 }).toEqual([LONG_A]);
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});
