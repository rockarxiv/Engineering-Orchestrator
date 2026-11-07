import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { closeApp, homeEnv } from "./support/app.js";

/**
 * A notification from the packaged macOS app reaches the system (EO-670).
 *
 * From Electron 42 a notification on macOS goes through UNNotification,
 * and macOS refuses it — `failed`, UNErrorDomain error 1 — from an app
 * that is not properly signed. An unsigned build carries only the
 * linker's automatic signature, which is not enough. EO's build is
 * ad-hoc signed for this (`mac.identity` in electron-builder.yml).
 *
 * Only the packaged app can say: the unpackaged one the rest of the suite
 * launches is Electron's own bundle, which is unsigned. So this runs only
 * when `EO_PACKAGED_APP` names a packaged app's executable, as
 * `e2e-macos` in ci.yml does after packaging, and on macOS, where the
 * signature is what decides.
 *
 * Electron emits `show` once macOS has accepted the request and `failed`
 * when it refuses it, so the event is the answer. Whether a banner is
 * then drawn is the person's setting in System Settings, which was true
 * before Electron 42 as well.
 */
test("the packaged app's notifications are accepted by macOS", async () => {
  const executablePath = process.env["EO_PACKAGED_APP"];
  test.skip(process.platform !== "darwin", "only macOS refuses a notification from an app that is not properly signed");
  test.skip(!executablePath, "EO_PACKAGED_APP names no packaged app; e2e-macos sets it after packaging");

  const scratch = mkdtempSync(path.join(tmpdir(), "eo e2e packaged notification "));
  const home = path.join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const env = Object.fromEntries(Object.entries(homeEnv(home)).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const app = await electron.launch({ executablePath: executablePath!, args: [`--user-data-dir=${path.join(home, ".config", "EO")}`], env });

  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const outcome = await app.evaluate(
      ({ Notification }) =>
        new Promise<string>((resolve) => {
          const notification = new Notification({ title: "EO", body: "A notification from the packaged app's e2e spec." });
          notification.on("show", () => resolve("show"));
          notification.on("failed", (_event, error) => resolve(`failed: ${error}`));
          notification.show();
        }),
    );
    expect(outcome).toBe("show");
  } finally {
    await closeApp(app);
    rmSync(scratch, { recursive: true, force: true });
  }
});
