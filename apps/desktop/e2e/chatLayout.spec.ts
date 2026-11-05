import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { closeApp, homeEnv, launchApp, skipFirstRun } from "./support/app.js";

/**
 * The chat layout never lengthens the document.
 *
 * Seen in the real app and only there: every assistant message carries a
 * screen-reader label (`sr-only`, which is `position: absolute`), and
 * with no positioned ancestor each one was placed against the document
 * rather than the transcript it sits in. A long conversation made the
 * document twice the window's height, and the wheel scrolled the whole
 * frame up out of sight — rail, header and all. jsdom lays nothing out,
 * so no unit test can see it.
 *
 * The spec puts the same thing where a long conversation would — an
 * absolutely placed label far down a transcript and a canvas view — and
 * asks the document how tall it is.
 */
test("a long transcript, or a long view, scrolls inside its own column and never moves the window", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e chat layout "));
  const home = path.join(scratch, "home");
  mkdirSync(home, { recursive: true });

  const { app, window: page } = await launchApp(homeEnv(home));

  try {
    await skipFirstRun(page);

    const transcript = page.getByLabel("Assistant transcript");
    await expect(transcript).toBeVisible({ timeout: 10_000 });

    /** Far down a scroller, the way the thirtieth message's label is: a tall block, then a label with no offsets of its own. */
    const longContentIn = (selector: string) =>
      page.evaluate((target) => {
        const host = document.querySelector(target)?.firstElementChild ?? document.querySelector(target);
        if (!host) throw new Error(`nothing at ${target}`);
        const block = document.createElement("div");
        block.style.height = "3000px";
        const label = document.createElement("span");
        label.className = "sr-only";
        label.textContent = "EO: ";
        host.append(block, label);
      }, selector);
    const documentHeight = () => page.evaluate(() => ({ scrolled: document.scrollingElement!.scrollHeight, window: window.innerHeight }));

    await longContentIn('[aria-label="Assistant transcript"]');
    const atHome = await documentHeight();
    expect(atHome.scrolled).toBe(atHome.window);

    // The wheel over the conversation scrolls the conversation, not the window.
    const box = await transcript.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 4000);
    await expect.poll(() => page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeInViewport();

    // And beside a view, whose own column is a scroller too.
    await page.evaluate(() => {
      window.location.hash = "#/settings";
    });
    await expect(page.getByRole("tabpanel", { name: "Open view" })).toBeVisible();
    await longContentIn('[aria-label="Open view"]');
    const besideAView = await documentHeight();
    expect(besideAView.scrolled).toBe(besideAView.window);
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});
