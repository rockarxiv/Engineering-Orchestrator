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

    // A menu open in the rail puts its backdrop over the whole window. Electron
    // applies drag regions in document order, so the header after it would
    // still move the window from under the backdrop: while one is up, no part
    // of the row is a handle.
    await page.getByRole("button", { name: "Switch project" }).click();
    await expect(page.getByRole("button", { name: "Switch project" })).toHaveAttribute("aria-expanded", "true");
    expect(await region(header)).toBe("no-drag");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Switch project" })).toHaveAttribute("aria-expanded", "false");
    expect(await region(header)).toBe("drag");

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

/**
 * Nothing of EO's under the window controls at any width the window can
 * be (EO-668), in the layout that is widest at the top: the rail, the
 * conversation unfolded beside a board, and the canvas. The conversation
 * gives way before the canvas would be squeezed under the controls, and
 * the window goes no narrower than the three can share.
 *
 * Every control and every piece of text is measured where it is actually
 * visible — clipped by whatever scrolls it — against the rectangle the
 * overlay really occupies.
 */
test("nothing in the top row is under the window controls, however narrow the window", async () => {
  test.skip(process.platform === "darwin", "macOS draws its traffic lights in the rail's fixed inset; there is no overlay at the right edge");
  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e title bar widths "));
  const home = path.join(scratch, "home");
  mkdirSync(home, { recursive: true });

  const { app, window: page } = await launchApp(homeEnv(home));

  try {
    await skipFirstRun(page);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link").filter({ hasText: "Delivery" }).click();
    await expect(page.getByRole("region", { name: "Canvas" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("region", { name: "Conversation" })).toBeVisible();

    // Never narrower than the rail, the conversation at 16rem and the canvas at its minimum can share.
    const minimum = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getMinimumSize()[0]);
    expect(minimum).toBe(760);

    type Overlay = { visible: boolean; getTitlebarAreaRect(): DOMRect };
    /** How wide the controls are by the overlay's own account: constant, so a resize has settled when it says so again. */
    const controlsWidth = () =>
      page.evaluate(() => {
        const area = (navigator as Navigator & { windowControlsOverlay?: Overlay }).windowControlsOverlay?.getTitlebarAreaRect();
        return area === undefined ? null : Math.round(window.innerWidth - area.x - area.width);
      });
    const controls = await controlsWidth();
    expect(controls).toBeGreaterThan(0);

    for (const width of [minimum, 800, 900, 1024, 1100]) {
      // The real window, not `sizeWindow`: pinning the page's viewport is
      // an emulation the overlay knows nothing of, and under it the title
      // bar area reports the whole width — so nothing could ever be found
      // under the controls. This case does not run on macOS, whose hosted
      // screen is what `sizeWindow` is for.
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size, 720), width);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      // The overlay's rectangle follows the resize a moment later.
      await expect.poll(controlsWidth).toBe(controls);

      const under = await page.evaluate(() => {
        const overlay = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay;
        if (!overlay?.visible) return ["no overlay"];
        const area = overlay.getTitlebarAreaRect();
        const left = area.x + area.width;
        const bottom = area.height;
        const found: string[] = [];
        const interactive = "button, a, input, select, textarea, [role='tab'], [role='button']";
        for (const element of document.body.querySelectorAll("*")) {
          const ownText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== "");
          if (!element.matches(interactive) && !ownText && element.tagName !== "svg") continue;
          // Where it is visible: its box, cut by every ancestor that clips.
          let box = element.getBoundingClientRect();
          let rect = { l: box.left, t: box.top, r: box.right, b: box.bottom };
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (style.overflowX === "visible" && style.overflowY === "visible") continue;
            box = parent.getBoundingClientRect();
            rect = { l: Math.max(rect.l, box.left), t: Math.max(rect.t, box.top), r: Math.min(rect.r, box.right), b: Math.min(rect.b, box.bottom) };
          }
          if (rect.r - rect.l <= 0 || rect.b - rect.t <= 0) continue;
          if (rect.r > left + 0.5 && rect.t < bottom - 0.5) {
            found.push(`${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(rect.l)}–${Math.round(rect.r)}`);
          }
        }
        return found;
      });
      expect(under, `at ${width}px wide`).toEqual([]);
    }
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});
