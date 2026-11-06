import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { attachRepository, closeApp, homeEnv, launchApp, sizeWindow } from "./support/app.js";
import { openView } from "./support/board.js";
import { seedItem } from "./support/seed.js";

/**
 * A board's head stays readable in a narrow canvas (EO-409).
 *
 * In the chat layout the board opens beside the conversation, so at the
 * size the window opens at the canvas is a few hundred pixels across.
 * The head kept its title and its actions side by side there: the switch
 * between the pipeline's views and the button beside it took the width
 * they needed, and what was left for the title and the status line was a
 * column that broke them one word to a line — with the button's far end
 * past the window's edge. jsdom lays nothing out, so no unit test can
 * see it; this asks the real window where things landed.
 *
 * And what the head holds (EO-518): a pipeline is changed through the
 * assistant, so neither the board nor the graph offers a way to the
 * configure screen, and the board has no Plan button and no add-work
 * caret — only Import from Jira, as a button of its own, disabled here
 * because this fixture connects no Jira project.
 */
test("a board's head keeps its title, its status line and its button readable beside the conversation", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e chat board header "));
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
    // The size the window opens at, said here so the spec does not move if that default does.
    await sizeWindow(app, page, 1100, 720);
    await attachRepository(page, repoPath);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1100);

    // The board, from the rail, the way a person opens it.
    const pipeline = page.getByRole("navigation", { name: "Main" }).locator('a[href*="/pipelines/"]').first();
    await expect(pipeline).toBeVisible({ timeout: 10_000 });
    await pipeline.click();

    const view = page.getByRole("tabpanel", { name: "Open view" });
    const head = view.locator("header").first();
    await expect(head.getByRole("navigation", { name: "Pipeline views" })).toBeVisible();
    // Beside the conversation, which is what makes the canvas narrow.
    await expect(page.getByLabel("Assistant transcript")).toBeVisible();

    // The title is all there: nothing of the name is cut off, and it is on one line.
    const title = await head.getByRole("heading", { level: 1 }).evaluate((heading) => {
      const name = heading.querySelector("span > span") ?? heading;
      const range = document.createRange();
      range.selectNodeContents(name);
      const lines = new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top)));
      return { text: name.textContent ?? "", cut: name.scrollWidth > name.clientWidth, lines: lines.size };
    });
    expect(title.text.trim()).not.toBe("");
    expect(title.cut).toBe(false);
    expect(title.lines).toBe(1);

    // The switch is Board and Graph, and nothing leads to the configure screen.
    const views = head.getByRole("navigation", { name: "Pipeline views" });
    await expect(views.getByRole("link")).toHaveText(["Board", "Graph"]);
    await expect(view.getByRole("link", { name: "Configure" })).toHaveCount(0);

    // No Plan button and no caret: Import from Jira is the head's one button,
    // disabled while no Jira project is connected, and wholly inside the window.
    await expect(head.getByRole("button", { name: "Plan in chat" })).toHaveCount(0);
    await expect(head.getByRole("button", { name: "More ways to add work" })).toHaveCount(0);
    const importing = head.getByRole("button", { name: "Import from Jira" });
    await expect(importing).toBeDisabled();
    await expect(importing).toHaveAttribute("title", "No Jira project is connected");
    await expect(importing).toBeInViewport({ ratio: 1 });

    // The status line: how many words landed on each line of it.
    const status = await head.locator("p").first().evaluate((line) => {
      const tops: number[] = [];
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        for (const word of text.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, word.index);
          range.setEnd(node, word.index + word[0].length);
          const rect = range.getBoundingClientRect();
          tops.push(rect.top + rect.height / 2);
        }
      }
      // Words whose middles are within half a line of each other share a line.
      const lines: number[][] = [];
      for (const top of tops.sort((a, b) => a - b)) {
        const last = lines.at(-1);
        if (last && top - last[0]! < 8) last.push(top);
        else lines.push([top]);
      }
      return { text: (line.textContent ?? "").trim(), words: lines.map((each) => each.length) };
    });
    expect(status.text).toContain("running");
    expect(status.text).toContain("Worktree");
    expect(status.text).toContain("Base");
    expect(status.words.length).toBeLessThanOrEqual(2);
    for (const words of status.words) expect(words).toBeGreaterThan(1);

    // The graph's switch is the same two, with nothing leading to the configure screen.
    await views.getByRole("link", { name: "Graph" }).click();
    await expect(views.getByRole("link", { name: "Graph" })).toHaveAttribute("aria-current", "page");
    await expect(views.getByRole("link")).toHaveText(["Board", "Graph"]);
    await expect(view.getByRole("link", { name: "Configure" })).toHaveCount(0);
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});

/**
 * An item's head keeps its title in a narrow canvas too (EO-646).
 *
 * The item's actions sat beside its title and took what they needed
 * first, so in a window 1024 wide — a hosted Mac's or Windows runner's
 * whole screen — the title was left a column no pixels wide: there in the
 * page, and nowhere on the screen. Found by the Jira spec on Windows,
 * whose window the screen made that narrow; held here at that size on
 * every platform.
 */
test("an item's head keeps its title readable beside the conversation in a window 1024 wide", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e chat item header "));
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
    await attachRepository(page, repoPath);
    await sizeWindow(app, page, 1024, 645);
    const seeded = seedItem(home, { title: "Rate limiting for the public API" });
    await page.evaluate((id) => {
      window.location.hash = `#/items/${id}`;
    }, seeded.id);

    // Beside the conversation, which is what makes the canvas narrow.
    await expect(page.getByLabel("Assistant transcript")).toBeVisible();
    const head = openView(page).locator("header").first();
    const heading = head.getByRole("heading", { level: 1, name: "Rate limiting for the public API" });
    await expect(heading).toBeVisible({ timeout: 10_000 });

    // Read as a title rather than a word to a line.
    const lines = await heading.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size;
    });
    expect(lines).toBeLessThanOrEqual(2);

    // And the actions are still there, wholly inside the window.
    await expect(head.getByRole("button", { name: "Archive" })).toBeInViewport({ ratio: 1 });
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});
