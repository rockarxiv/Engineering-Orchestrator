import { rmSync } from "node:fs";
import { ipcContract, type IpcChannel } from "@eo/core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { getSetting, setSetting } from "../db/repos/settingsRepo.js";
import type { DbHandle } from "../db/client.js";
import { fakePlatform as createFakePlatform } from "../testing/platform.js";
import type { Platform } from "./platform.js";
import { clearHandlerRegistry, dispatchIpc, registeredChannels } from "./registry.js";

/**
 * That the handlers run without Electron (KAN-127).
 *
 * `registerAllHandlers` used to make twenty-three direct Electron calls,
 * which meant the one file that registers all 161 channels could only be
 * loaded inside a running Electron process — `registration.test.ts` says
 * so, and reads the file as *text* for exactly that reason. The seam
 * this story adds is a `Platform` interface the composition root fills
 * in, and the proof that it is a real seam is this: a fake platform, a
 * migrated in-memory database, plain Node, every channel registered.
 *
 * A grep for `"electron"` in handlers.ts was that story's acceptance
 * criterion, and `platform/electronConfinement.test.ts` is now that grep
 * kept for the whole of main. This is the part a grep cannot see — that
 * nothing this file *calls* during registration reaches for Electron
 * either. `startMain.test.ts` says the same thing of the whole process.
 *
 * `ipcMain` is not mocked any more, and nothing here needs it to be:
 * since EO-318 the renderer's door is hung once, by the platform, from
 * the same registry this file reads. Registering a handler no longer
 * touches Electron at all.
 */

const directories: string[] = [];
const handles: DbHandle[] = [];

/** The shared fake machine (testing/platform.ts), with its directory cleaned up here. */
function fakePlatform(): Platform {
  const platform = createFakePlatform();
  directories.push(platform.userDataPath);
  return platform;
}

afterEach(() => {
  clearHandlerRegistry();
});

afterAll(() => {
  for (const handle of handles) handle.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

async function registerEverything(platform: Platform = fakePlatform()): Promise<void> {
  const handle = openMigratedTestDb();
  handles.push(handle);
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform });
}

describe("registering every handler under plain Node", () => {
  it("answers every channel in the contract", async () => {
    await registerEverything();

    // Not "most of them": the file is one long list of registrations,
    // and a machine channel quietly dropped from it is a screen that
    // stops working in a build nobody runs a test against.
    expect([...registeredChannels()].sort()).toEqual((Object.keys(ipcContract) as IpcChannel[]).sort());
  });

  it("takes the version from the platform rather than from Electron", async () => {
    // The smallest end-to-end proof that the seam is load-bearing:
    // `app.getVersion()` would throw here, and this answers.
    await registerEverything();

    await expect(dispatchIpc("app:getVersion", undefined)).resolves.toEqual({ ok: true, data: { version: "9.9.9" } });
  });

  it("asks the platform for a directory rather than opening a dialog itself", async () => {
    const platform = { ...fakePlatform(), pickDirectory: vi.fn(() => Promise.resolve("/chosen")) };
    await registerEverything(platform);

    await expect(dispatchIpc("dialog:pickDirectory", { title: "Pick one" })).resolves.toEqual({ ok: true, data: { path: "/chosen" } });
    expect(platform.pickDirectory).toHaveBeenCalledWith({ title: "Pick one" });
  });

  it("hands a cancelled picker back as the same nothing it always was", async () => {
    // The shape every caller of a dialog already handles. A platform
    // that answers `null` must not become a thrown error on the way out
    // — behaviour preservation is the whole of this story.
    await registerEverything();

    await expect(dispatchIpc("dialog:pickDirectory", {})).resolves.toEqual({ ok: true, data: { path: null } });
    await expect(dispatchIpc("attachments:pick", undefined)).resolves.toEqual({ ok: true, data: { attachments: [], omitted: 0, problem: null } });
  });

  it("answers view:current from the platform's window, not BrowserWindow's", async () => {
    await registerEverything();

    const result = await dispatchIpc("view:current", undefined);

    // `hasWindow: () => false` above, so this is the absence sentence
    // rather than a screen — which is exactly what a headless main will
    // answer for the rest of time.
    expect(result).toMatchObject({ ok: true, data: { view: null } });
  });

  it("starts on a database that still holds the removed licence key's rows", async () => {
    // EO-627 took the licence key out and left its two app_settings rows
    // where they were, with nothing reading them. A database written
    // before that still has to open, register every channel and answer.
    const handle = openMigratedTestDb();
    handles.push(handle);
    setSetting(handle.db, "license.key", "EO1-abc.def");
    setSetting(handle.db, "license.promptSnoozedUntil", 1_700_000_000_000);
    const { registerAllHandlers } = await import("./handlers.js");
    registerAllHandlers(handle.db, undefined, { platform: fakePlatform() });

    expect([...registeredChannels()].sort()).toEqual((Object.keys(ipcContract) as IpcChannel[]).sort());
    expect([...registeredChannels()].filter((name) => name.startsWith("license:"))).toEqual([]);
    await expect(dispatchIpc("projects:list", undefined)).resolves.toMatchObject({ ok: true });
    expect(getSetting(handle.db, "license.key", null)).toBe("EO1-abc.def");
    expect(getSetting(handle.db, "license.promptSnoozedUntil", null)).toBe(1_700_000_000_000);
  });
});
