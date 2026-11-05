import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { developerType } from "@eo/core";
import { openDb } from "./db/client.js";
import { getItem } from "./db/repos/index.js";
import { createTestItem, openMigratedTestDbAt } from "./db/testHelpers.js";
import { clearHandlerRegistry, dispatchIpc } from "./ipc/registry.js";
import { openAssistConversation } from "./roles/assist.js";
import { fakePlatform, sourceTreeResources } from "./testing/platform.js";
import { startMain, type RunningMain } from "./startMain.js";
import { removeScratch } from "./testing/scratch.js";

/**
 * That the whole main process runs on a fake machine (EO-318,
 * `ARCHITECTURE.md`, "The server").
 *
 * This is the story's acceptance criterion, and it is the only test that
 * can state it: handlers.test.ts proves the *handlers* need no Electron,
 * and electronConfinement.test.ts proves no file outside `platform/`
 * *names* it — but neither would catch a composition root that reached
 * for `app` on its way to building the engine, because until this story
 * there was no composition root anything could call. Now there is one,
 * it takes the machine as an argument, and this starts it: database,
 * migrations, engine, packs, schedulers, MCP hosts, handlers, and a real
 * request answered through the same `dispatchIpc` the MCP host uses.
 *
 * The mocks below are the teeth. Vitest calls a factory the first time
 * something imports the module, so a single `import "electron"` anywhere
 * in that graph — however deep, however transitive — fails this test
 * with the sentence it throws, rather than quietly resolving to the
 * package's path string and dying later at the first `app.getPath`.
 */
vi.mock("electron", () => {
  throw new Error("startMain loaded Electron. Nothing below the platform may import it.");
});
vi.mock("electron-updater", () => {
  throw new Error("startMain loaded electron-updater. Only platform/electron.ts may import it.");
});

/**
 * The calls startup makes that a test needs to see the order of (EO-566).
 * `sweepUnusedCodexHomes` is wrapped rather than replaced: it still
 * sweeps, and this records the moment it was called — which a folder's
 * disappearance cannot show, since an asynchronous sweep started too
 * early would leave the folder there until its first await settled.
 */
const startupCalls = vi.hoisted(() => [] as string[]);
vi.mock("./engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine.js")>();
  return {
    ...actual,
    sweepUnusedCodexHomes: (...args: Parameters<typeof actual.sweepUnusedCodexHomes>) => {
      startupCalls.push("sweepUnusedCodexHomes");
      return actual.sweepUnusedCodexHomes(...args);
    },
  };
});

/**
 * Startup is chatty, and some of it arrives late.
 *
 * `checkGitAvailable()` logs whenever git answers, which can be after
 * this file's last test — and a console line written while vitest is
 * tearing the worker down is reported as an unhandled
 * `EnvironmentTeardownError` rather than as the harmless thing it is.
 * Silenced for the whole file and never restored, so nothing escapes
 * through the gap between the last `afterEach` and teardown.
 */
beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

let running: { main: RunningMain; userDataPath: string } | null = null;

afterEach(async () => {
  // The registry is a module-level value for the reason registry.ts
  // gives — every reader wants the same answer — so a second `startMain`
  // in one file would find every channel already taken.
  clearHandlerRegistry();
  if (!running) return;
  const { main, userDataPath } = running;
  running = null;
  await main.stop();
  removeScratch(userDataPath);
});

/** Starts the app on a temporary machine and registers it for teardown. */
function start(overrides: Parameters<typeof fakePlatform>[0] = {}) {
  // Unpackaged, because that is what a checkout is: it settles
  // `exposeErrorDetails` and keeps the deferred updater inert, which is
  // the same answer `startAutoUpdate` gives when run from source.
  const platform = fakePlatform({ isPackaged: false, version: "7.7.7", ...overrides });
  const main = startMain(platform);
  running = { main, userDataPath: platform.userDataPath };
  return { platform, main };
}

describe("starting the main process with a fake platform", () => {
  it("serves a request over dispatchIpc without Electron", async () => {
    const { platform } = start();

    // The machine's own answer, through the handler the renderer calls:
    // `app.getVersion()` would have thrown here before KAN-127, and the
    // module holding it would not even have loaded before this story.
    await expect(dispatchIpc("app:getVersion", undefined)).resolves.toEqual({ ok: true, data: { version: "7.7.7" } });

    // And a record-half request, which is what a server will serve: this
    // one answers from tables that exist only because the migrations in
    // `platform.resources` ran a moment ago.
    await expect(dispatchIpc("projects:list", undefined)).resolves.toEqual({
      ok: true,
      data: { projects: [], activeProjectId: null },
    });

    expect(existsSync(join(platform.userDataPath, "eo.db"))).toBe(true);
  });

  it("opens the door before the surface that knocks on it", () => {
    const order: string[] = [];
    start({
      serveIpc: () => order.push("serveIpc"),
      openUserInterface: () => order.push("openUserInterface"),
    });

    // Not a stylistic preference. A renderer invokes IPC as it loads, so
    // a window opened before the door was hung would race the app's
    // first screen against its own handlers.
    expect(order).toEqual(["serveIpc", "openUserInterface"]);
  });

  it("gives the coordinator the one way out of the process", () => {
    const onBeforeQuit = vi.fn();
    start({ onBeforeQuit });

    // One handler, registered once: the shutdown coordinator's, which is
    // what makes a second close request idempotent rather than a
    // cancellation of the first (shutdownCoordinator.ts).
    expect(onBeforeQuit).toHaveBeenCalledTimes(1);
    expect(onBeforeQuit).toHaveBeenCalledWith(expect.any(Function));
  });

  it("refuses to start on a failed migration, and says so on the machine's own terms", async () => {
    const showErrorBox = vi.fn();
    const exit = vi.fn();
    const here = dirname(fileURLToPath(import.meta.url));
    const { platform } = start({
      showErrorBox,
      exit,
      // A resource layout with no migrations in it: `runMigrations`
      // throws, which is the one startup failure EO refuses to survive —
      // a half-migrated database is worse than no app.
      resources: { ...sourceTreeResources(), migrations: join(here, "no-such-migrations") },
    });
    expect(existsSync(join(platform.userDataPath, "eo.db"))).toBe(true); // opened, then refused

    expect(showErrorBox).toHaveBeenCalledWith("EO failed to start", expect.stringContaining("A database migration failed"));
    expect(exit).toHaveBeenCalledWith(1);
    // Nothing was registered, so nothing answers — rather than half an
    // app answering from a database it could not finish upgrading.
    await expect(dispatchIpc("projects:list", undefined)).resolves.toMatchObject({ ok: false });
  });

  /**
   * EO-566: the window is not kept waiting on housekeeping no screen's
   * first read depends on.
   */
  it("opens the window before it calls sweepUnusedCodexHomes", async () => {
    startupCalls.length = 0;
    start({ openUserInterface: () => startupCalls.push("openUserInterface") });

    await vi.waitFor(() => expect(startupCalls).toContain("sweepUnusedCodexHomes"));
    expect(startupCalls).toEqual(["openUserInterface", "sweepUnusedCodexHomes"]);
  });

  it("sweeps away the Codex homes nobody uses once the window is open", async () => {
    const platform = fakePlatform({ isPackaged: false, version: "7.7.7" });
    const stale = join(platform.userDataPath, "codex-homes", "an-agent-that-was-deleted");
    mkdirSync(stale, { recursive: true });

    running = { main: startMain(platform), userDataPath: platform.userDataPath };

    await vi.waitFor(() => expect(existsSync(stale)).toBe(false));
  });

  /**
   * EO-526, through the composition root itself rather than the step on
   * its own: what a desktop starts, and what `server/start.ts` starts on
   * an organisation server. The rows are gone by the time `startMain`
   * returns, which is to say before anything could dispatch against one.
   */
  it("deletes the conversations Discussions and the Architecture panel left, and no other", () => {
    const platform = fakePlatform({ isPackaged: false, version: "7.7.7" });
    const databasePath = join(platform.userDataPath, "eo.db");
    const before = openMigratedTestDbAt(databasePath);
    const discussion = createTestItem(before.db, { type: developerType("feature"), title: "Conversation", stepId: "discussion", keyPrefix: "DISC" });
    const architecture = createTestItem(before.db, { type: developerType("feature"), title: "Pipeline configuration", stepId: "architecture", keyPrefix: "ARCH" });
    const assistant = openAssistConversation(before.db, null);
    before.close();

    running = { main: startMain(platform), userDataPath: platform.userDataPath };

    const after = openDb(databasePath);
    try {
      expect(getItem(after.db, discussion.id)).toBeUndefined();
      expect(getItem(after.db, architecture.id)).toBeUndefined();
      expect(getItem(after.db, assistant.id)).toMatchObject({ key: assistant.key });
    } finally {
      after.close();
    }
  });
});
