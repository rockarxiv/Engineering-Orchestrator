import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { closeApp, homeEnv, launchApp, skipFirstRun } from "./support/app.js";

/**
 * The main window's top row is its title bar (EO-668).
 *
 * What jsdom cannot show: whether Chromium takes the row as somewhere to
 * drag the window from and its controls as somewhere not to, and whether
 * the room the row leaves at its right end is the room Electron's window
 * controls actually take. Asked of the real window, on each platform the
 * suite runs on — the overlay on Windows and Linux, the inset traffic
 * lights on macOS, where there is no overlay to ask.
 */
test("the top row drags the window and leaves room for the window controls", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e title bar "));
  const home = path.join(scratch, "home");
  mkdirSync(home, { recursive: true });

  const { app, window: page } = await launchApp(homeEnv(home));

  try {
    await skipFirstRun(page);
    const conversation = page.getByRole("region", { name: "Conversation" });
    const header = conversation.locator("header");
    await expect(header).toBeVisible({ timeout: 10_000 });

    const region = (locator: typeof header) => locator.evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-app-region"));
    expect(await region(header)).toBe("drag");
    expect(await region(header.getByRole("button", { name: "Hide the side panel" }))).toBe("no-drag");
    expect(await region(page.getByRole("button", { name: "Switch project" }))).toBe("no-drag");

    const overlay = await page.evaluate(() => {
      const controls = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay;
      if (!controls?.visible) return null;
      const area = controls.getTitlebarAreaRect();
      return { height: area.height, controlsWidth: window.innerWidth - area.x - area.width };
    });

    if (process.platform === "darwin") {
      // The traffic lights are the system's, in the rail's top inset.
      expect(overlay).toBeNull();
      return;
    }

    // Electron's overlay, as tall as the top row above its rule, at its right end.
    expect(overlay).not.toBeNull();
    expect(overlay!.height).toBe(51);
    expect(overlay!.controlsWidth).toBeGreaterThan(0);

    // The overview is at the window's right edge, with a strip of title
    // bar above it as tall as the controls drawn on it.
    const strip = page.getByRole("region", { name: "Overview" }).locator("xpath=preceding-sibling::div[1]");
    expect(await region(strip)).toBe("drag");
    expect((await strip.boundingBox())?.height).toBe(51);

    // Hidden, the conversation's header is at the edge, and ends short of the controls.
    await header.getByRole("button", { name: "Hide the side panel" }).click();
    await expect(page.getByRole("region", { name: "Overview" })).toHaveCount(0);
    const paddingEnd = await header.evaluate((element) => parseFloat(getComputedStyle(element).paddingRight));
    expect(paddingEnd).toBeCloseTo(20 + overlay!.controlsWidth, 0);
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});
