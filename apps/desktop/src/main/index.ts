import { app } from "electron";
import type { Platform } from "./ipc/platform.js";
import { createElectronPlatform } from "./platform/electron.js";
import { startMain } from "./startMain.js";

/**
 * The Electron entry point, and nothing else (EO-318,
 * `ARCHITECTURE.md`, "The server").
 *
 * This file used to be the composition root: five hundred lines of
 * database, engine, schedulers, MCP hosts and window, with the Electron
 * calls threaded through them. The composition is now `startMain`, which
 * imports nothing from Electron and takes one argument — the machine —
 * and what is left here is the part that is true only of a desktop
 * launch: the single-instance lock, the command-line switch that has to
 * be set before the app is ready, and building the platform at the one
 * moment `app.getPath` has an answer.
 *
 * The same `startMain` runs on a server (the next story), given a
 * `Platform` of its own. This file and `platform/` are the only two
 * places in the main process allowed to import Electron, which
 * `platform/electronConfinement.test.ts` keeps true.
 */

// Which keyring holds the Jira token (J-01). Chromium picks one from the
// desktop environment and gets it wrong often enough on Linux that
// naming it has to be possible — and Playwright forces `basic` on every
// Electron it launches, which is why an e2e cannot otherwise store a
// secret at all. This only chooses between real backends: `basic` is
// Chromium's plaintext store, `isEncryptionAvailable()` is false for it,
// and credentials.ts refuses to write a token there.
//
// Here rather than in the platform because it has to be said before
// `app.whenReady()`, and the platform is not built until after it.
//
// On a Mac there is one real backend, the keychain, and what Playwright
// asks for there is `--use-mock-keychain`: a fake that encrypts with a
// fixed key, so an e2e that stores a secret would prove nothing about the
// keychain. Setting the variable at all asks for the real one back
// (EO-646). Playwright adds that switch from inside the app, which other
// projects report is already too late for safeStorage to see. If so,
// this removes nothing, and the real keychain was in use anyway. Linux's
// switch is meaningless on a Mac and harmless; Windows has DPAPI and
// neither switch.
const passwordStore = process.env["EO_PASSWORD_STORE"];
if (passwordStore) {
  app.commandLine.appendSwitch("password-store", passwordStore);
  if (process.platform === "darwin") app.commandLine.removeSwitch("use-mock-keychain");
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  /**
   * The machine, once it exists.
   *
   * Held only so that a second launch can ask it to show the window.
   * Before `whenReady` there is nothing to show and nothing to hold, so
   * the optional call is the honest one rather than a guard against a
   * case that cannot happen.
   */
  let platform: Platform | undefined;

  // A second launch means "I want EO in front of me", and what that
  // means is the *main* window. This used to take the first entry of
  // Electron's window list, which is creation order and would hand back
  // the canvas's or the debug window as readily as the main one.
  // `showWindow` is where that choice lives now, and it is the same one
  // a clicked notification makes.
  app.on("second-instance", () => platform?.showWindow());

  void app.whenReady().then(() => {
    // The machine, built once now that Electron is ready — `app.getPath`
    // and `app.getVersion` have answers from this moment and not before
    // (KAN-127). Everything downstream asks this rather than Electron.
    //
    // `__dirname` is passed in because only an entry point can honestly
    // answer where it was loaded from, and both the preload and the
    // unpackaged resource paths hang off it.
    platform = createElectronPlatform({ mainDir: __dirname });
    startMain(platform);
  });

  // Every window. Electron fires this when the *last* one goes, and
  // closing the main window closes the canvas's and the debug window
  // with it — so the app still quits on the gesture that always quit
  // it, and a window somebody left open does not become a process with
  // no visible reason to exist.
  app.on("window-all-closed", () => {
    app.quit();
  });
}
