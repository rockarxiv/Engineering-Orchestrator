import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Platform } from "../ipc/platform.js";
import { resolveResourcePaths, type ResourcePaths } from "../resources.js";

/**
 * A machine with nobody at it, for tests (EO-318).
 *
 * Every member answered, and every answer a lie nobody is asked to
 * believe: the dialogs cancel, the keychain is a passthrough, the
 * notifications go nowhere, and there is no window. What it is *not* is
 * a stub of the whole interface — `userDataPath` is a real temporary
 * directory and `resources` really points at this repository's
 * migrations and prompts, because the thing worth testing is the app
 * composing itself against a fake machine rather than a fake app.
 *
 * Here rather than in one test file because two now need it —
 * handlers.test.ts, which registers every channel under plain Node, and
 * startMain.test.ts, which starts the whole main process the same way —
 * and a second copy would be a second place to forget a member when the
 * interface grows. It is the shape the server's `Platform` has to fill
 * in for real, so anything awkward to fake here is worth noticing now.
 *
 * Under `testing/` rather than beside `platform/electron.ts`, which is
 * where it would read best, because that directory is the one EO ships
 * nothing out of: testing.test.ts holds it to having no production
 * importer and the coverage globs leave it out of the denominator. A
 * fake nobody runs would otherwise count against the figure as dead
 * code, which is exactly what it is and exactly what it should be.
 *
 * The caller owns the temporary directory: `rmSync(platform.userDataPath)`
 * when it is done.
 */
export function fakePlatform(overrides: Partial<Platform> = {}): Platform {
  const userDataPath = mkdtempSync(join(tmpdir(), "eo-platform-"));

  return {
    pickDirectory: () => Promise.resolve(null),
    pickFile: () => Promise.resolve([]),
    saveFile: () => Promise.resolve(null),
    openPath: () => Promise.resolve(""),
    openExternal: () => Promise.resolve(),
    userDataPath,
    keychain: {
      isEncryptionAvailable: () => false,
      encryptString: (plainText: string) => Buffer.from(plainText),
      decryptString: (encrypted: Buffer) => encrypted.toString(),
    },
    notify: () => {},
    hasWindow: () => false,
    // No window, so nothing appears — the same answer a headless main
    // gives (EO-383). A test that cares overrides it.
    openCanvas: () => false,
    // Nor a debug window (EO-392).
    openDebug: () => false,
    hasCanvas: () => false,
    closeCanvas: () => {},
    // A test's platform stands in for a desktop unless it says
    // otherwise: most of what is tested here is the machine half.
    hasMachine: true,
    isPackaged: true,
    version: "9.9.9",
    resources: sourceTreeResources(),
    serveIpc: () => {},
    openUserInterface: () => {},
    // Nothing to load. `startDeferredAutoUpdate` never asks on an
    // unpackaged build, and a packaged fake gets the same answer a
    // platform that is updated by something other than itself gives.
    loadAutoUpdater: () => Promise.resolve(undefined),
    onBeforeQuit: () => {},
    quit: () => {},
    // Deliberately not `process.exit`: a fake machine that could end the
    // test runner is a fake machine nobody can write a test with.
    exit: () => {},
    showErrorBox: () => {},
    onWake: () => () => {},
    sleeps: true,
    isOnline: () => true,
    askQuestion: () => Promise.resolve(null),
    setBadgeCount: () => {},
    showWindow: () => {},
    ...overrides,
  };
}

/**
 * The resource paths of an unpackaged build, resolved through the real
 * resolver rather than a second copy of the layout.
 *
 * `resolveResourcePaths` answers `<mainDir>/../../src/main` for a
 * development build, so the directory to hand it is the `out/main` that
 * `electron-vite build` would have written — which need not exist, since
 * nothing reads it and every path it produces is under `src/`.
 *
 * Exported so a test can take these and bend one entry — the migrations
 * that are not there — without building a whole second platform to
 * throw away.
 */
export function sourceTreeResources(): ResourcePaths {
  const mainSrcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  return resolveResourcePaths({
    isPackaged: false,
    resourcesPath: "",
    mainDir: join(mainSrcRoot, "..", "..", "out", "main"),
  });
}
