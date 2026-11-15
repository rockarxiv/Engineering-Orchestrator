import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The desktop's windows: the main one, the canvas's (EO-383) and the
 * debug window (EO-392).
 *
 * `createElectronPlatform` is the one file allowed to say
 * `new BrowserWindow`, so this is the only place the wiring around
 * several of them can be asserted at all — and the wiring is where the
 * risks live: the `closed` handler that clears the published view and
 * tears the push bridge down, the single `ViewSnapshot`, and
 * `getAllWindows()[0]` standing in for "the app's window".
 *
 * Electron is replaced wholesale by the factory below. That is the same
 * device `startMain.test.ts` uses, pointed the other way: there it
 * throws, to prove nothing below the platform loads Electron; here it
 * answers, because the platform *is* the Electron half and the only way
 * to test it under plain Node is to be the Electron it talks to. The
 * fake is deliberately dumb — it records calls and fires the handlers
 * that were registered on it — so what is proved is EO's wiring rather
 * than a re-implementation of Chromium's window lifecycle.
 */

// ─── Electron, as far as the platform can see it ─────────────────────

interface FakeWindowOptions {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  title?: string;
  minWidth?: number;
  minHeight?: number;
  alwaysOnTop?: boolean;
  titleBarStyle?: string;
  titleBarOverlay?: unknown;
  trafficLightPosition?: unknown;
}

/** What `loadFile`/`loadURL` were asked for, so a hash can be asserted. */
interface Loaded {
  file?: string;
  url?: string;
  hash?: string;
  search?: string;
}

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = [];

  readonly options: FakeWindowOptions;
  readonly loaded: Loaded = {};
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  readonly sent: { channel: string; payload: unknown }[] = [];
  readonly contentsHandlers = new Map<string, ((...args: unknown[]) => void)[]>();
  readonly webContents: {
    send: (channel: string, payload: unknown) => void;
    setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => void;
    openDevTools: () => void;
    on: (event: string, handler: (...args: unknown[]) => void) => void;
  };
  /** How many times a page was loaded into it, first load included (EO-793). */
  loads = 0;

  windowOpenHandler: ((details: { url: string }) => { action: string }) | undefined;
  destroyed = false;
  shown = false;
  focused = false;
  minimized = false;
  fullScreen = false;
  overlays: unknown[] = [];
  bounds = { x: 0, y: 0, width: 0, height: 0 };

  constructor(options: FakeWindowOptions = {}) {
    this.options = options;
    this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 0, height: options.height ?? 0 };
    this.webContents = {
      send: (channel, payload) => this.sent.push({ channel, payload }),
      setWindowOpenHandler: (handler) => {
        this.windowOpenHandler = handler;
      },
      openDevTools: () => {},
      on: (event, handler) => {
        const existing = this.contentsHandlers.get(event) ?? [];
        existing.push(handler);
        this.contentsHandlers.set(event, existing);
      },
    };
    FakeBrowserWindow.instances.push(this);
  }

  static getAllWindows(): FakeBrowserWindow[] {
    return FakeBrowserWindow.instances.filter((window) => !window.destroyed);
  }

  static getFocusedWindow(): FakeBrowserWindow | null {
    return FakeBrowserWindow.getAllWindows().find((window) => window.focused) ?? null;
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  /** What Chromium does to the page inside: `did-fail-load`, `render-process-gone`, `did-finish-load`. */
  emitContents(event: string, ...args: unknown[]): void {
    for (const handler of this.contentsHandlers.get(event) ?? []) handler({}, ...args);
  }

  private load(): Promise<void> {
    this.loads += 1;
    return Promise.resolve();
  }

  /** What the OS does when the window is really closed: `close`, then `closed`. */
  close(): void {
    if (this.destroyed) return;
    this.emit("close", { preventDefault: () => {} });
    this.destroyed = true;
    this.emit("closed");
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  isFullScreen(): boolean {
    return this.fullScreen;
  }
  /** What the OS does on the green button or F11: the state, then the event. */
  setFullScreen(fullScreen: boolean): void {
    this.fullScreen = fullScreen;
    this.emit(fullScreen ? "enter-full-screen" : "leave-full-screen");
  }
  setTitleBarOverlay(options: unknown): void {
    this.overlays.push(options);
  }
  restore(): void {
    this.minimized = false;
  }
  show(): void {
    this.shown = true;
  }
  focus(): void {
    for (const window of FakeBrowserWindow.instances) window.focused = false;
    this.focused = true;
  }
  getNormalBounds() {
    return this.bounds;
  }
  loadFile(file: string, options?: { hash?: string; search?: string }): Promise<void> {
    this.loaded.file = file;
    if (options?.hash !== undefined) this.loaded.hash = options.hash;
    if (options?.search !== undefined) this.loaded.search = options.search;
    return this.load();
  }
  loadURL(url: string): Promise<void> {
    this.loaded.url = url;
    return this.load();
  }
}

/** Every display the fake machine has. Cases replace it. */
let displays: { workArea: { x: number; y: number; width: number; height: number } }[] = [
  { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
];

let userDataPath = "";
const appHandlers = new Map<string, (() => void)[]>();
const openedExternally: string[] = [];
/** Every message box shown, and the button the fake person presses on the next one. */
const messageBoxes: { parent: unknown; options: { message: string; detail?: string; buttons: string[] } }[] = [];
let messageBoxAnswer = 1;

vi.mock("electron", () => ({
  app: {
    // Unpackaged, which is what a checkout is — and what keeps
    // `resolveResourcePaths` off `process.resourcesPath`, which plain
    // Node does not have. With no `ELECTRON_RENDERER_URL` set it still
    // takes the `loadFile` path a release build takes.
    isPackaged: false,
    getPath: () => userDataPath,
    getVersion: () => "7.7.7",
    on: (event: string, handler: () => void) => {
      const existing = appHandlers.get(event) ?? [];
      existing.push(handler);
      appHandlers.set(event, existing);
    },
    quit: () => {},
    exit: () => {},
    setBadgeCount: () => {},
  },
  BrowserWindow: FakeBrowserWindow,
  screen: { getAllDisplays: () => displays },
  shell: {
    openExternal: (url: string) => {
      openedExternally.push(url);
      return Promise.resolve();
    },
    openPath: () => Promise.resolve(""),
  },
  dialog: {
    showMessageBox: (parent: unknown, options: { message: string; detail?: string; buttons: string[] }) => {
      messageBoxes.push({ parent, options });
      return Promise.resolve({ response: messageBoxAnswer, checkboxChecked: false });
    },
  },
  ipcMain: { handle: () => {} },
  Notification: class {},
  safeStorage: { isEncryptionAvailable: () => false },
}));

const {
  canvasBoundsPath,
  createElectronPlatform,
  debugBoundsPath,
  fitOntoAvailableDisplay,
  MAIN_MIN_WIDTH,
  MAIN_RENDERER_RELOAD_DELAY_MS,
  MAIN_RENDERER_RELOADS,
  mainWindowChrome,
  readSavedBounds,
  TITLE_BAR_HEIGHT,
} = await import("./electron.js");
const { askFromCanvas, canvasState, closeCanvas, openInCanvas, popOutCanvas, resetCanvasWindow } = await import("../ipc/canvasWindow.js");
const { readCurrentView } = await import("../ipc/currentView.js");
const { clearPublishedView, publishedPage, publishView } = await import("../ipc/currentView.js");
const { emitPush } = await import("../ipc/push.js");
const { openDebugWindow, setDebugMode } = await import("../ipc/debugCommands.js");
const { openMigratedTestDb } = await import("../db/testHelpers.js");

/** A `ViewSnapshot` for the board, as the main window would publish one. */
const BOARD_VIEW = {
  page: { route: "/project", params: {} },
  filter: null,
  selection: [],
  sort: null,
  unsavedEdits: [],
};

function platformOnTemporaryMachine() {
  return createElectronPlatform({ mainDir: join(userDataPath, "out", "main") });
}

/** The windows in creation order: the main one first. */
function windows() {
  return FakeBrowserWindow.instances;
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), "eo-windows-"));
  FakeBrowserWindow.instances = [];
  appHandlers.clear();
  openedExternally.length = 0;
  messageBoxes.length = 0;
  messageBoxAnswer = 1;
  displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  clearPublishedView();
  resetCanvasWindow();
});

afterEach(() => {
  // Every window bridges pushes to itself: a case that opened one and
  // never closed it leaves that bridge listening past the suite.
  for (const window of FakeBrowserWindow.getAllWindows()) window.close();
  clearPublishedView();
  rmSync(userDataPath, { recursive: true, force: true });
});

describe("the main window", () => {
  it("loads the renderer with no hash at all", () => {
    const platform = platformOnTemporaryMachine();
    void platform.openUserInterface();

    expect(windows()).toHaveLength(1);
    // The index with no hash, which is what makes every other window a
    // `HashRouter` decision rather than a second entry point.
    expect(windows()[0]!.loaded.file).toMatch(/renderer[/\\]index\.html$/);
    expect(windows()[0]!.loaded.hash).toBeUndefined();
  });

  it("uses the dev server's URL when there is one", () => {
    process.env["ELECTRON_RENDERER_URL"] = "http://localhost:5173";
    try {
      const platform = platformOnTemporaryMachine();
      void platform.openUserInterface();

      expect(windows()[0]!.loaded.url).toBe("http://localhost:5173");
    } finally {
      delete process.env["ELECTRON_RENDERER_URL"];
    }
  });

  it("denies window.open and sends the URL to the OS browser", () => {
    const platform = platformOnTemporaryMachine();
    void platform.openUserInterface();

    expect(windows()[0]!.windowOpenHandler?.({ url: "https://example.invalid/whatever" })).toEqual({ action: "deny" });
    expect(openedExternally).toEqual(["https://example.invalid/whatever"]);
  });

  it("clears the published view when it closes, and takes the windows beside it along", () => {
    const platform = platformOnTemporaryMachine();
    void platform.openUserInterface();
    publishView(BOARD_VIEW);
    platform.openCanvas("/inbox");
    const [main, canvas] = windows();

    main!.close();

    // Both gone, so Electron's `window-all-closed` fires and the app
    // quits on the gesture that has always quit it — rather than leaving
    // a second window holding the process open behind a main window the
    // person thought they had closed.
    expect(canvas!.isDestroyed()).toBe(true);
    expect(FakeBrowserWindow.getAllWindows()).toHaveLength(0);
    expect(publishedPageNow()).toBeNull();
    expect(platform.hasWindow()).toBe(false);
  });

  /**
   * `hasWindow` means the *main* window. Answering "yes, somebody is
   * looking" because some other window is up would have `view_current`
   * describe a screen nobody can see.
   */
  it("does not count a window beside it as a window somebody is looking at", () => {
    const platform = platformOnTemporaryMachine();
    platform.openCanvas("/inbox");

    expect(FakeBrowserWindow.getAllWindows()).toHaveLength(1);
    expect(platform.hasWindow()).toBe(false);
  });
});

/**
 * The main window's own title bar (EO-668): no native one, the system's
 * controls over EO's top row, and only on the main window.
 */
/**
 * EO-793: a main window whose page did not load is reloaded, a bounded
 * number of times, and then the person is told — never left blank.
 */
describe("the main window when its page does not load", () => {
  /** Chromium's numbers for the two failures that matter here. */
  const ERR_ABORTED = -3;
  const ERR_FAILED = -2;

  let warned: string[];
  let failed: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    warned = [];
    failed = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void warned.push(String(line)));
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void failed.push(String(line)));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * The main window, open, with its first load made. `loaded()` is
   * whether `openUserInterface` has resolved — what releases the work
   * that reads the keychain synchronously.
   */
  function opened() {
    const platform = platformOnTemporaryMachine();
    let loaded = false;
    void platform.openUserInterface().then(() => {
      loaded = true;
    });
    const main = windows()[0]!;
    expect(main.loads).toBe(1);
    return { platform, main, loaded: () => loaded };
  }

  /** A failed main-frame load, as Chromium reports it. */
  function failLoad(main: FakeBrowserWindow, code = ERR_FAILED, description = "ERR_FAILED", isMainFrame = true): void {
    main.emitContents("did-fail-load", code, description, "file:///eo/renderer/index.html", isMainFrame);
  }

  /** Past the longest wait between reloads. */
  async function waitOutTheReload(): Promise<void> {
    await vi.advanceTimersByTimeAsync(MAIN_RENDERER_RELOAD_DELAY_MS * MAIN_RENDERER_RELOADS);
  }

  it("says which load failed and loads the page again", async () => {
    const { main } = opened();

    failLoad(main, ERR_FAILED, "ERR_FAILED");

    expect(warned).toContain("[eo] the main window failed to load file:///eo/renderer/index.html: ERR_FAILED (error -2)");
    await waitOutTheReload();
    expect(main.loads).toBe(2);
    expect(main.loaded.file).toMatch(/renderer[/\\]index\.html$/);
  });

  it("leaves alone a load another navigation replaced, and a frame inside the page", async () => {
    const { main } = opened();

    failLoad(main, ERR_ABORTED, "ERR_ABORTED");
    failLoad(main, ERR_FAILED, "ERR_FAILED", false);

    await waitOutTheReload();
    expect(main.loads).toBe(1);
    expect(warned).toEqual([]);
  });

  it("says why its renderer process went and loads the page again", async () => {
    const { main } = opened();

    main.emitContents("render-process-gone", { reason: "crashed", exitCode: 139 });

    expect(warned).toContain("[eo] the main window's renderer process is gone: crashed (exit code 139)");
    await waitOutTheReload();
    expect(main.loads).toBe(2);
  });

  it("does not fight a renderer that was asked to end", async () => {
    const { main } = opened();

    main.emitContents("render-process-gone", { reason: "clean-exit", exitCode: 0 });

    await waitOutTheReload();
    expect(main.loads).toBe(1);
  });

  it("counts one failure reported twice as one reload", async () => {
    const { main } = opened();

    main.emitContents("render-process-gone", { reason: "crashed", exitCode: 139 });
    failLoad(main);

    await waitOutTheReload();
    expect(main.loads).toBe(2);
  });

  it(`reloads at most ${MAIN_RENDERER_RELOADS} times, then tells the person and the log`, async () => {
    const { main, loaded } = opened();

    for (let attempt = 1; attempt <= MAIN_RENDERER_RELOADS; attempt += 1) {
      failLoad(main);
      await waitOutTheReload();
      expect(main.loads).toBe(attempt + 1);
    }
    expect(messageBoxes).toEqual([]);
    expect(loaded()).toBe(false);

    main.emitContents("render-process-gone", { reason: "oom", exitCode: 1 });
    await waitOutTheReload();

    // No more loads: an explanation instead, over the window it is about.
    expect(main.loads).toBe(MAIN_RENDERER_RELOADS + 1);
    expect(messageBoxes).toHaveLength(1);
    expect(messageBoxes[0]!.parent).toBe(main);
    expect(messageBoxes[0]!.options.message).toBe("EO's window could not be loaded");
    expect(messageBoxes[0]!.options.detail).toContain("the renderer process oom (exit code 1)");
    expect(main.shown).toBe(true);
    expect(failed).toEqual([expect.stringContaining(`could not load after ${MAIN_RENDERER_RELOADS} reloads`)]);
    // Giving up is not loading: what reads the keychain synchronously
    // stays held back, however long the box stays up.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(loaded()).toBe(false);
  });

  it("starts over when the person asks to try again, and is loaded once that works", async () => {
    const { main, loaded } = opened();
    messageBoxAnswer = 0;

    for (let attempt = 0; attempt <= MAIN_RENDERER_RELOADS; attempt += 1) {
      failLoad(main);
      await waitOutTheReload();
    }

    expect(messageBoxes).toHaveLength(1);
    expect(main.loads).toBe(MAIN_RENDERER_RELOADS + 2);
    // A fresh allowance: the next failure is reloaded, not refused.
    failLoad(main);
    await waitOutTheReload();
    expect(main.loads).toBe(MAIN_RENDERER_RELOADS + 3);
    expect(messageBoxes).toHaveLength(1);
    expect(loaded()).toBe(false);

    main.emitContents("did-finish-load");
    await vi.advanceTimersByTimeAsync(0);
    expect(loaded()).toBe(true);
  });

  it("logs a load that rejected rather than dropping it", async () => {
    const platform = platformOnTemporaryMachine();
    // Set on the class: the window is made inside openUserInterface.
    const load = vi.spyOn(FakeBrowserWindow.prototype, "loadFile").mockRejectedValueOnce(new Error("ERR_FAILED (-2) loading 'file:///eo/renderer/index.html'"));

    void platform.openUserInterface();
    await vi.advanceTimersByTimeAsync(0);

    expect(load).toHaveBeenCalledTimes(1);
    expect(warned).toContain("[eo] a window's page did not load: ERR_FAILED (-2) loading 'file:///eo/renderer/index.html'");
  });

  it("is loaded once its first page has finished loading", async () => {
    const { main, loaded } = opened();
    await vi.advanceTimersByTimeAsync(0);
    expect(loaded()).toBe(false);

    main.emitContents("did-finish-load");
    await vi.advanceTimersByTimeAsync(0);

    expect(loaded()).toBe(true);
  });

  it("is not loaded by time passing with no page", async () => {
    const { loaded } = opened();

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(loaded()).toBe(false);
  });

  it("does not count the error page a failed load finishes on, only the reload that worked", async () => {
    const { main, loaded } = opened();

    failLoad(main);
    // Chromium can finish the error page it drew for the failure.
    main.emitContents("did-finish-load");
    await vi.advanceTimersByTimeAsync(0);
    expect(loaded()).toBe(false);

    await waitOutTheReload();
    expect(main.loads).toBe(2);
    main.emitContents("did-finish-load");
    await vi.advanceTimersByTimeAsync(0);
    expect(loaded()).toBe(true);
  });

  it("is not loaded by the window closing, and is by the next main window's page", async () => {
    const { platform, main, loaded } = opened();

    main.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(loaded()).toBe(false);

    platform.showWindow();
    const reopened = windows()[1]!;
    reopened.emitContents("did-finish-load");
    await vi.advanceTimersByTimeAsync(0);
    expect(loaded()).toBe(true);
  });
});

describe("the main window's title bar", () => {
  const pushed = (window: FakeBrowserWindow, channel: string) => window.sent.filter((push) => push.channel === `push:${channel}`).map((push) => push.payload);

  it("hides the native title bar on every platform and keeps the system's controls", () => {
    // Windows and Linux: Electron's overlay, as tall as the top row above its rule.
    for (const platform of ["linux", "win32"] as const) {
      expect(mainWindowChrome(platform)).toEqual({
        minWidth: MAIN_MIN_WIDTH,
        titleBarStyle: "hidden",
        titleBarOverlay: { color: expect.stringMatching(/^#[0-9a-f]{6}$/), symbolColor: expect.stringMatching(/^#[0-9a-f]{6}$/), height: 51 },
      });
    }
    // macOS: the inset traffic lights, moved into the rail's top inset —
    // and no overlay, which has nothing to draw there.
    expect(mainWindowChrome("darwin")).toEqual({ titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 10 } });
    expect(TITLE_BAR_HEIGHT).toBe(51);
    // The rail, the conversation at 16rem and the canvas at 6rem, beside Windows' 138px of controls.
    expect(MAIN_MIN_WIDTH).toBeGreaterThanOrEqual(250 + 256 + 96 + 138);
  });

  it("is what the main window is made with, and not the windows beside it", () => {
    const { db, close } = openMigratedTestDb();
    try {
      setDebugMode(db, true);
      const platform = platformOnTemporaryMachine();
      void platform.openUserInterface();
      platform.openCanvas("/inbox");
      openDebugWindow(db, platform);
      const [main, canvas, debug] = windows();

      expect(main!.options).toMatchObject(mainWindowChrome(process.platform));
      // The canvas and the debug window keep their native frames.
      for (const other of [canvas!, debug!]) {
        expect(other.options.titleBarStyle).toBeUndefined();
        expect(other.options.titleBarOverlay).toBeUndefined();
      }
    } finally {
      close();
    }
  });

  it("colours the overlay on the main window, where there is one to colour", () => {
    const platform = platformOnTemporaryMachine();
    expect(platform.setTitleBarColours({ color: "#262624", symbolColor: "#c3c1b8" })).toBe(false);

    void platform.openUserInterface();
    platform.openCanvas("/inbox");
    const [main, canvas] = windows();
    const applied = platform.setTitleBarColours({ color: "#262624", symbolColor: "#c3c1b8" });

    if (process.platform === "darwin") {
      // The traffic lights are the system's, and take no colours.
      expect(applied).toBe(false);
      expect(main!.overlays).toEqual([]);
    } else {
      expect(applied).toBe(true);
      expect(main!.overlays).toEqual([{ color: "#262624", symbolColor: "#c3c1b8" }]);
    }
    expect(canvas!.overlays).toEqual([]);
  });

  it("says when the main window goes into full screen and comes out", () => {
    const platform = platformOnTemporaryMachine();
    expect(platform.isFullScreen()).toBe(false);
    void platform.openUserInterface();
    const [main] = windows();

    main!.setFullScreen(true);
    expect(platform.isFullScreen()).toBe(true);
    expect(pushed(main!, "window:changed")).toEqual([{}]);

    main!.setFullScreen(false);
    expect(platform.isFullScreen()).toBe(false);
    expect(pushed(main!, "window:changed")).toEqual([{}, {}]);
  });
});

describe("which window is the app's", () => {
  it("shows and focuses the main window, never the one beside it", () => {
    const platform = platformOnTemporaryMachine();
    void platform.openUserInterface();
    platform.openCanvas("/inbox");
    const [main, canvas] = windows();
    main!.minimized = true;
    canvas!.focus();

    platform.showWindow();

    expect(main!.minimized).toBe(false);
    expect(main!.focused).toBe(true);
    expect(canvas!.focused).toBe(false);
  });

  it("brings the main window back when it is the one that is gone", () => {
    const platform = platformOnTemporaryMachine();
    void platform.openUserInterface();
    platform.openCanvas("/inbox");
    // The main window alone, as macOS leaves it — the cascade is on
    // `closed`, so this is the shape a future where they part company
    // takes.
    windows()[0]!.destroyed = true;

    platform.showWindow();

    expect(platform.hasWindow()).toBe(true);
  });

  /**
   * The other caller of the same choice, which is not in this file.
   *
   * `index.ts` handles `second-instance` — a person launching EO again
   * when it is already running — and it used to focus
   * `BrowserWindow.getAllWindows()[0]`. That is creation order, and with
   * several windows it would hand back whichever was made first. It goes
   * through `showWindow` now, so there is one answer to "which window is
   * the app's" and the cases above are about it.
   *
   * Read out of the source because the entry point cannot be imported
   * without running a single-instance lock against a real `app`.
   */
  it("routes a second launch through showWindow rather than picking a window itself", () => {
    const entry = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf8");

    expect(entry).toContain('app.on("second-instance", () => platform?.showWindow());');
    expect(entry).not.toContain("getAllWindows()");
  });

  it("reopens the main window on activate even while another is up", () => {
    const platform = platformOnTemporaryMachine();
    void platform.openUserInterface();
    platform.openCanvas("/inbox");
    windows()[0]!.destroyed = true;

    for (const handler of appHandlers.get("activate") ?? []) handler();

    // The condition is "no main window", not "no windows at all":
    // clicking the dock icon with only the canvas up has to bring EO back.
    expect(platform.hasWindow()).toBe(true);
  });
});

/**
 * The geometry on its own, because the interesting cases are ones no
 * test machine has: a second monitor, and then not having it.
 */
describe("fitting saved bounds onto the displays that are actually there", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1080 };
  const secondary = { x: 1920, y: 0, width: 2560, height: 1440 };

  it("leaves a window that is where it was left", () => {
    const bounds = { x: 2100, y: 100, width: 800, height: 900 };
    expect(fitOntoAvailableDisplay(bounds, [primary, secondary])).toEqual(bounds);
  });

  it("leaves a window straddling two displays, because somebody put it there", () => {
    const bounds = { x: 1700, y: 100, width: 600, height: 500 };
    expect(fitOntoAvailableDisplay(bounds, [primary, secondary])).toEqual(bounds);
  });

  it("pulls a window onto the only display left when the other is unplugged", () => {
    const fitted = fitOntoAvailableDisplay({ x: 2100, y: 100, width: 800, height: 900 }, [primary]);

    expect(fitted).toEqual({ x: 1120, y: 100, width: 800, height: 900 });
  });

  it("shrinks a window that no longer fits the display it is being put on", () => {
    const fitted = fitOntoAvailableDisplay({ x: 3000, y: 2000, width: 2000, height: 1400 }, [{ x: 0, y: 0, width: 1280, height: 800 }]);

    expect(fitted).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });

  it("leaves bounds alone when there are no displays to reason about", () => {
    const bounds = { x: 10, y: 10, width: 100, height: 100 };
    expect(fitOntoAvailableDisplay(bounds, [])).toEqual(bounds);
  });
});

describe("reading the remembered bounds", () => {
  it("refuses anything that is not four finite numbers", () => {
    const path = join(userDataPath, "bounds.json");
    for (const body of ['{"x":1,"y":2,"width":3}', '{"x":null,"y":2,"width":3,"height":4}', "[]", '"nope"', '{"x":1,"y":2,"width":0,"height":4}']) {
      writeFileSync(path, body, "utf8");
      expect(readSavedBounds(path), body).toBeNull();
    }
  });

  it("answers null for a file that is not there at all", () => {
    expect(readSavedBounds(join(userDataPath, "never-written.json"))).toBeNull();
  });
});

// ─── helpers ─────────────────────────────────────────────────────────

/** What `view_current` would resolve from, as a descriptor. */
function publishedPageNow(): unknown {
  return publishedPage();
}

/**
 * The canvas, popped out into a window of its own (EO-383).
 *
 * Tested here because this is the one file that can be the Electron the
 * platform talks to. The cases drive it the way the app does — through
 * `ipc/canvasWindow.ts`, which is what `canvas:*` reaches — so what is
 * proved is the two together: the window the platform makes, and what
 * the main window is told when it goes.
 */
describe("the canvas in its own window", () => {
  const TABS = { tabs: ["/pipelines/p1", "/items/i1?tab=runs"], active: "/items/i1?tab=runs" };

  /** Everything a window was pushed on one channel. */
  const pushed = (window: FakeBrowserWindow, channel: string) => window.sent.filter((push) => push.channel === `push:${channel}`).map((push) => push.payload);

  function withTheBoardOpen() {
    const platform = platformOnTemporaryMachine();
    void platform.openUserInterface();
    return { platform, board: windows()[0]! };
  }

  it("opens the same renderer in a second window, at the open tab, marked as the canvas's", () => {
    const { platform, board } = withTheBoardOpen();

    expect(popOutCanvas(platform, TABS)).toEqual({ opened: true });

    expect(windows()).toHaveLength(2);
    const canvas = windows()[1]!;
    expect(canvas.loaded.file).toBe(board.loaded.file);
    // The address is the view's own, so the page it publishes is the
    // view's; what makes it the canvas is in front of the hash, where a
    // navigation does not rewrite it.
    expect(canvas.loaded.hash).toBe("/items/i1?tab=runs");
    expect(canvas.loaded.search).toBe("window=canvas");
    expect(platform.hasCanvas()).toBe(true);
    // And it opens with the tabs it was popped out with.
    expect(canvasState(platform)).toEqual({ poppedOut: true, ...TABS });
    // Both windows hear that the canvas is out.
    expect(pushed(board, "canvas:changed")).toEqual([{ poppedOut: true, restore: null }]);
  });

  it("uses the dev server's URL with the same marker and hash when there is one", () => {
    process.env["ELECTRON_RENDERER_URL"] = "http://localhost:5173";
    try {
      const { platform } = withTheBoardOpen();
      popOutCanvas(platform, TABS);

      expect(windows()[0]!.loaded.url).toBe("http://localhost:5173");
      expect(windows()[1]!.loaded.url).toBe("http://localhost:5173?window=canvas#/items/i1?tab=runs");
    } finally {
      delete process.env["ELECTRON_RENDERER_URL"];
    }
  });

  it("raises the window it has, without reloading it, when something is opened in it", () => {
    const { platform } = withTheBoardOpen();
    popOutCanvas(platform, TABS);
    const canvas = windows()[1]!;
    canvas.minimized = true;
    canvas.shown = false;

    expect(openInCanvas(platform, { path: "/inbox" })).toEqual({ opened: true });

    expect(windows()).toHaveLength(2);
    expect(canvas.minimized).toBe(false);
    expect(canvas.shown).toBe(true);
    expect(canvas.focused).toBe(true);
    // Sent as a push, because the window holds its tabs and a reload
    // would lose them…
    expect(canvas.loaded.hash).toBe("/items/i1?tab=runs");
    expect(pushed(canvas, "canvas:opened")).toEqual([{ path: "/inbox" }]);
    // …and remembered, for a window that had not loaded far enough to hear it.
    expect(canvasState(platform)).toEqual({ poppedOut: true, tabs: [...TABS.tabs, "/inbox"], active: "/inbox" });
  });

  it("opens nothing in a canvas window that is not there", () => {
    const { platform } = withTheBoardOpen();

    expect(openInCanvas(platform, { path: "/inbox" })).toEqual({ opened: false });
    expect(closeCanvas(platform, { restore: null })).toEqual({ closed: false });
    expect(windows()).toHaveLength(1);
    expect(canvasState(platform)).toEqual({ poppedOut: false, tabs: [], active: null });
  });

  // EO-408: a view in the canvas window asks for the composer, which is in the main one.
  it("brings the main window forward and tells it to take the cursor, when the canvas asks for the conversation", () => {
    const { platform, board } = withTheBoardOpen();
    // Nothing to hand over from while the canvas is beside the conversation.
    expect(askFromCanvas(platform)).toEqual({ handed: false });
    expect(pushed(board, "canvas:asked")).toEqual([]);

    popOutCanvas(platform, TABS);
    board.minimized = true;
    board.focused = false;

    expect(askFromCanvas(platform)).toEqual({ handed: true });

    expect(board.minimized).toBe(false);
    expect(board.focused).toBe(true);
    expect(pushed(board, "canvas:asked")).toEqual([{}]);
    // The canvas stays as it was: asking is not popping in.
    expect(platform.hasCanvas()).toBe(true);
  });

  it("hands the tabs back to the main window on a pop-in, once the window has gone", () => {
    const { platform, board } = withTheBoardOpen();
    popOutCanvas(platform, TABS);
    const restore = { tabs: ["/pipelines/p1", "/inbox"], active: "/inbox" };

    expect(closeCanvas(platform, { restore })).toEqual({ closed: true });

    expect(windows()[1]!.destroyed).toBe(true);
    expect(platform.hasCanvas()).toBe(false);
    expect(pushed(board, "canvas:changed").at(-1)).toEqual({ poppedOut: false, restore });
    // The main window is what the person is going back to.
    expect(board.focused).toBe(true);
    expect(canvasState(platform)).toEqual({ poppedOut: false, tabs: [], active: null });
  });

  it("closes the canvas, handing nothing back, on Close the canvas and on the window's own close", () => {
    const { platform, board } = withTheBoardOpen();

    popOutCanvas(platform, TABS);
    closeCanvas(platform, { restore: null });
    expect(pushed(board, "canvas:changed").at(-1)).toEqual({ poppedOut: false, restore: null });

    // The person pressing the window's own close button: no channel at all.
    popOutCanvas(platform, TABS);
    windows()[2]!.close();
    expect(pushed(board, "canvas:changed")).toEqual([
      { poppedOut: true, restore: null },
      { poppedOut: false, restore: null },
      { poppedOut: true, restore: null },
      { poppedOut: false, restore: null },
    ]);
    // And a pop-in that was asked for is not handed back a second time.
    popOutCanvas(platform, TABS);
    closeCanvas(platform, { restore: TABS });
    popOutCanvas(platform, TABS);
    windows()[4]!.close();
    expect(pushed(board, "canvas:changed").at(-1)).toEqual({ poppedOut: false, restore: null });
  });

  it("stops the pushes to it alone, and does not ask the process to stop", () => {
    const { platform, board } = withTheBoardOpen();
    popOutCanvas(platform, TABS);
    const canvas = windows()[1]!;
    canvas.close();
    const before = canvas.sent.length;

    emitPush("items:changed", {});

    expect(canvas.sent).toHaveLength(before);
    expect(pushed(board, "items:changed")).toHaveLength(1);
    expect(platform.hasWindow()).toBe(true);
  });

  /**
   * What the assistant sees. While the canvas is out its window is the
   * one publishing (`ViewPublisher`, and `chat/ChatLayout.test.tsx` for
   * that end), so `view_current` describes it — and when it goes, what
   * it said goes with it rather than describing a window nobody has.
   */
  it("is the screen view_current describes while it is open, and takes that with it", () => {
    const { platform } = withTheBoardOpen();
    popOutCanvas(platform, TABS);
    // The canvas's window, saying what it shows.
    publishView({ ...BOARD_VIEW, page: { route: "/settings", params: {} } });

    const answer = readCurrentView(undefined as never, { hasWindow: () => platform.hasWindow() });
    expect(answer.view).toMatchObject({ route: "/settings", showing: { kind: "screen", screen: { name: "Settings" } } });

    windows()[1]!.close();

    expect(publishedPageNow()).toBeNull();
  });

  it("goes with the main window", () => {
    const { platform, board } = withTheBoardOpen();
    popOutCanvas(platform, TABS);

    board.close();

    expect(windows()[1]!.destroyed).toBe(true);
    expect(platform.hasCanvas()).toBe(false);
  });

  it("denies window.open, like every window", () => {
    const { platform } = withTheBoardOpen();
    popOutCanvas(platform, TABS);

    expect(windows()[1]!.windowOpenHandler?.({ url: "https://example.invalid/canvas" })).toEqual({ action: "deny" });
    expect(openedExternally).toEqual(["https://example.invalid/canvas"]);
  });

  describe("where it was last time", () => {
    function writeCanvasBounds(bounds: unknown) {
      const path = canvasBoundsPath(userDataPath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(bounds), "utf8");
    }

    it("writes where it was when it closes, in a file of its own", () => {
      const { platform } = withTheBoardOpen();
      popOutCanvas(platform, TABS);
      const canvas = windows()[1]!;
      canvas.bounds = { x: 2100, y: 80, width: 1400, height: 1000 };

      canvas.close();

      expect(readSavedBounds(canvasBoundsPath(userDataPath))).toEqual({ x: 2100, y: 80, width: 1400, height: 1000 });
      // Not the debug window's: the two windows are remembered apart.
      expect(readSavedBounds(debugBoundsPath(userDataPath))).toBeNull();
    });

    it("reopens where it was left, on the display it was left on", () => {
      displays = [
        { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
        { workArea: { x: 1920, y: 0, width: 2560, height: 1440 } },
      ];
      const saved = { x: 2100, y: 80, width: 1400, height: 1000 };
      writeCanvasBounds(saved);
      const { platform } = withTheBoardOpen();

      popOutCanvas(platform, TABS);

      expect(windows()[1]!.options).toMatchObject(saved);
    });

    it("is put on a display that is there when the one it was on is gone", () => {
      writeCanvasBounds({ x: 2100, y: 80, width: 1400, height: 1000 });
      const { platform } = withTheBoardOpen();

      popOutCanvas(platform, TABS);

      const { x, y, width, height } = windows()[1]!.options;
      expect(x! >= 0 && x! + width! <= 1920).toBe(true);
      expect(y! >= 0 && y! + height! <= 1080).toBe(true);
    });

    it("opens where a new window would when nothing has been written down", () => {
      const { platform } = withTheBoardOpen();

      popOutCanvas(platform, TABS);

      // No `x`/`y` at all rather than a guess at a corner: that is
      // Electron's own "put it where you would put a new window", and it
      // is the honest answer on a first launch.
      expect(windows()[1]!.options.x).toBeUndefined();
      expect(windows()[1]!.options.y).toBeUndefined();
      expect(windows()[1]!.options.width).toBeGreaterThan(0);
    });

    it("opens anyway when the file somebody hand-edited is nonsense", () => {
      const path = canvasBoundsPath(userDataPath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{ not json at all", "utf8");
      const { platform } = withTheBoardOpen();

      expect(popOutCanvas(platform, TABS)).toEqual({ opened: true });
      expect(windows()[1]!.options.x).toBeUndefined();
    });

    it("is an ordinary window rather than one pinned above the main one, with no maximum size", () => {
      const { platform } = withTheBoardOpen();

      popOutCanvas(platform, TABS);

      expect(windows()[1]!.options.alwaysOnTop).toBeUndefined();
      expect(windows()[1]!.options).not.toHaveProperty("maxWidth");
      expect(windows()[1]!.options).not.toHaveProperty("maxHeight");
    });
  });
});

/**
 * The debug window (EO-392).
 *
 * Driven the way F12 drives it — through `openDebugWindow`, which is
 * what `debug:window` reaches — against a real database holding the
 * setting, so what is proved is the gate and the window together: no
 * window while debug mode is off, one while it is on, and never two.
 */
describe("the debug window", () => {
  function withTheBoardOpen() {
    const platform = platformOnTemporaryMachine();
    void platform.openUserInterface();
    const handle = openMigratedTestDb();
    return { platform, db: handle.db, board: windows()[0]!, close: () => handle.close() };
  }

  it("opens nothing while debug mode is off", () => {
    const { platform, db, close } = withTheBoardOpen();
    try {
      expect(openDebugWindow(db, platform)).toEqual({ opened: false });
      expect(windows()).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("opens the same renderer in a window of its own, marked as the debug window's", () => {
    const { platform, db, board, close } = withTheBoardOpen();
    try {
      setDebugMode(db, true);

      expect(openDebugWindow(db, platform)).toEqual({ opened: true });

      expect(windows()).toHaveLength(2);
      const debug = windows()[1]!;
      expect(debug.loaded.file).toBe(board.loaded.file);
      expect(debug.loaded.search).toBe("window=debug");
      expect(debug.options.title).toBe("Debug");
    } finally {
      close();
    }
  });

  it("uses the dev server's URL with the same marker when there is one", () => {
    process.env["ELECTRON_RENDERER_URL"] = "http://localhost:5173";
    const { platform, db, close } = withTheBoardOpen();
    try {
      setDebugMode(db, true);
      openDebugWindow(db, platform);

      expect(windows()[1]!.loaded.url).toBe("http://localhost:5173?window=debug#/");
    } finally {
      delete process.env["ELECTRON_RENDERER_URL"];
      close();
    }
  });

  it("focuses the window it already has on a second F12, rather than opening another", () => {
    const { platform, db, close } = withTheBoardOpen();
    try {
      setDebugMode(db, true);
      openDebugWindow(db, platform);
      const debug = windows()[1]!;
      debug.minimized = true;
      debug.shown = false;
      windows()[0]!.focus();

      expect(openDebugWindow(db, platform)).toEqual({ opened: true });

      expect(windows()).toHaveLength(2);
      expect(debug.minimized).toBe(false);
      expect(debug.shown).toBe(true);
      expect(debug.focused).toBe(true);
    } finally {
      close();
    }
  });

  it("opens again after it has been closed, and not once debug mode is switched off", () => {
    const { platform, db, close } = withTheBoardOpen();
    try {
      setDebugMode(db, true);
      openDebugWindow(db, platform);
      windows()[1]!.close();

      expect(openDebugWindow(db, platform)).toEqual({ opened: true });
      expect(FakeBrowserWindow.getAllWindows()).toHaveLength(2);

      FakeBrowserWindow.getAllWindows()[1]!.close();
      setDebugMode(db, false);
      expect(openDebugWindow(db, platform)).toEqual({ opened: false });
      expect(FakeBrowserWindow.getAllWindows()).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("hears pushes of its own, which is what keeps its activity live, and stops hearing them alone", () => {
    const { platform, db, board, close } = withTheBoardOpen();
    try {
      setDebugMode(db, true);
      openDebugWindow(db, platform);
      const debug = windows()[1]!;

      emitPush("runs:progress", { runId: "r1" });
      expect(debug.sent.filter((push) => push.channel === "push:runs:progress")).toHaveLength(1);

      debug.close();
      emitPush("runs:progress", { runId: "r1" });
      expect(debug.sent.filter((push) => push.channel === "push:runs:progress")).toHaveLength(1);
      // The board's bridge is its own and is untouched.
      expect(board.sent.filter((push) => push.channel === "push:runs:progress")).toHaveLength(2);
    } finally {
      close();
    }
  });

  it("publishes no view and clears none: view_current goes on answering about the board", () => {
    const { platform, db, close } = withTheBoardOpen();
    try {
      setDebugMode(db, true);
      publishView(BOARD_VIEW);
      openDebugWindow(db, platform);

      windows()[1]!.close();

      expect(publishedPage()).toEqual(BOARD_VIEW.page);
      expect(platform.hasWindow()).toBe(true);
    } finally {
      close();
    }
  });

  it("goes with the board's window, and denies window.open like every window", () => {
    const { platform, db, board, close } = withTheBoardOpen();
    try {
      setDebugMode(db, true);
      openDebugWindow(db, platform);
      const debug = windows()[1]!;

      expect(debug.windowOpenHandler?.({ url: "https://example.com/" })).toEqual({ action: "deny" });
      expect(openedExternally).toEqual(["https://example.com/"]);

      board.close();
      expect(debug.destroyed).toBe(true);
    } finally {
      close();
    }
  });

  it("remembers where it was", () => {
    const { platform, db, close } = withTheBoardOpen();
    try {
      setDebugMode(db, true);
      openDebugWindow(db, platform);
      const debug = windows()[1]!;
      debug.bounds = { x: 40, y: 60, width: 1000, height: 700 };
      debug.close();

      expect(readSavedBounds(debugBoundsPath(userDataPath))).toEqual({ x: 40, y: 60, width: 1000, height: 700 });

      openDebugWindow(db, platform);
      expect(FakeBrowserWindow.getAllWindows()[1]!.options).toMatchObject({ x: 40, y: 60, width: 1000, height: 700 });
    } finally {
      close();
    }
  });
});

describe("a machine with no screen", () => {
  it("opens no debug window, and says so, even with debug mode on", async () => {
    const { fakePlatform } = await import("../testing/platform.js");
    const platform = fakePlatform();
    const handle = openMigratedTestDb();
    try {
      setDebugMode(handle.db, true);
      expect(openDebugWindow(handle.db, platform)).toEqual({ opened: false });
    } finally {
      handle.close();
      rmSync(platform.userDataPath, { recursive: true, force: true });
    }
  });


  it("pops nothing out, and says so", async () => {
    const { fakePlatform } = await import("../testing/platform.js");
    const platform = fakePlatform();
    try {
      expect(popOutCanvas(platform, { tabs: ["/inbox"], active: "/inbox" })).toEqual({ opened: false });
      // Nothing was remembered for a window that never opened.
      expect(canvasState(platform)).toEqual({ poppedOut: false, tabs: [], active: null });
    } finally {
      rmSync(platform.userDataPath, { recursive: true, force: true });
    }
  });
});
