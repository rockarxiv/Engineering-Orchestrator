import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  Notification,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
} from "electron";
import { CANVAS_WINDOW_SEARCH, DEBUG_WINDOW_SEARCH, withActingAgent } from "@eo/core";
import { canvasWindowClosed } from "../ipc/canvasWindow.js";
import { clearPublishedView } from "../ipc/currentView.js";
import type { Platform } from "../ipc/platform.js";
import { bridgePushChannels, emitPush } from "../ipc/push.js";
import { dispatchIpc, registeredChannels } from "../ipc/registry.js";
import { resolveResourcePaths } from "../resources.js";
import type { InjectedUpdater } from "../updater.js";
import { webContentsTransport } from "./webContentsTransport.js";

/**
 * The Electron implementation of `Platform` — the desktop app's answer
 * to what the machine provides (KAN-127, EO-318).
 *
 * **This file and index.ts are the only two in the main process allowed
 * to import Electron**, and `platform/electronConfinement.test.ts` is
 * what keeps that true. Everything else — the handlers, the engine, the
 * schedulers, the MCP hosts, the whole of `startMain` — reaches the
 * machine through the interface above and would run identically on a
 * host with no Electron in it at all, which is the point of phase 7a
 * (`ARCHITECTURE.md`, "The server").
 *
 * So the four things that used to be spread across index.ts,
 * registerHandler.ts and notifications.ts are here: the windows and what
 * pushes reach them, the `ipcMain` door, the ways out of the process,
 * and the badge. `safeStorage` is imported in exactly one place, as
 * the design asks of it, and the dialogs are parented to the window
 * that asked so a sheet is modal to it on macOS instead of floating
 * loose.
 *
 * Built once by index.ts, after `app.whenReady()`: `app.getPath` and
 * `app.getVersion` are read at construction, which is the moment they
 * are known and the moment every previous caller read them.
 *
 * **There are three windows.** The main one, which is the app. The
 * chat layout's canvas (EO-383), popped out so the conversation keeps
 * its width. And the debug window (EO-392), which shows what EO handed
 * each agent's backend and what the agent is doing with it. All three
 * live here, because `new BrowserWindow` may not be written anywhere
 * else, and the whole of the difference between them is below: the two
 * extra windows each get their own push bridge and their own disposer,
 * remember their bounds, close with the main window, and are not what
 * `hasWindow` counts. The canvas *is* a screen about something, so it
 * publishes the view while it is open and clears it when it goes; the
 * debug window publishes no view and clears none — it is an instrument
 * pointed at the runs, not a screen an agent should be told the person
 * is looking at. And only the main window hides its native title bar
 * (EO-668, `mainWindowChrome`): the other two keep their frames.
 *
 * @param mainDir the directory the main bundle was loaded from —
 *   `__dirname`, which only the entry point can honestly answer, and
 *   from which the preload and the unpackaged resource paths hang.
 */
export function createElectronPlatform(options: { mainDir: string }): Platform {
  const { mainDir } = options;

  // Migrations, prompts and the MCP server script are read from disk at
  // runtime, so they ship as extraResources rather than in the bundle
  // (P-01). One resolver for all of them — see resources.ts.
  const resources = resolveResourcePaths({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir,
  });

  /**
   * What runs when something asks this process to stop, whatever asked.
   *
   * Held rather than only registered, because a window's `close` is one
   * of the ways and a window does not exist yet when `startMain`
   * registers it.
   */
  let requestClose: ((event: { preventDefault: () => void }) => void) | undefined;

  const isDev = !app.isPackaged;

  const userDataPath = app.getPath("userData");

  /**
   * The person's window, and the two that open beside it.
   *
   * Held rather than looked up, because `BrowserWindow.getAllWindows()`
   * cannot tell them apart and three things turn on which is which:
   * `hasWindow` answers `view_current` and must mean *the main* window,
   * `showWindow` and `activate` must reach the main window rather than
   * whichever window happens to be first in the list, and closing the
   * main window takes the others with it.
   */
  let mainWindow: BrowserWindow | undefined;
  let canvasWindow: BrowserWindow | undefined;
  let debugWindow: BrowserWindow | undefined;

  /** Alive, as opposed to closed-but-still-referenced. */
  const alive = (window: BrowserWindow | undefined): window is BrowserWindow => window !== undefined && !window.isDestroyed();

  /**
   * What a renderer is loaded with, in one place for every window.
   *
   * Routing is a `HashRouter` — chosen because the production build is
   * loaded over `file://`, which has no server to resolve real paths —
   * so a second window is the same `index.html` with a different hash
   * rather than a second entry point or a second build target.
   */
  function loadRenderer(window: BrowserWindow, hash?: string, search?: string): void {
    const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
    if (isDev && rendererUrl) {
      const query = search === undefined ? "" : `?${search}`;
      void window.loadURL(hash === undefined ? `${rendererUrl}${query}` : `${rendererUrl}${query}#${hash}`);
      return;
    }
    const indexHtml = join(mainDir, "../renderer/index.html");
    if (hash === undefined) void window.loadFile(indexHtml);
    else void window.loadFile(indexHtml, search === undefined ? { hash } : { hash, search });
  }

  /**
   * No window opens a window.
   *
   * Every `window.open` and every target=_blank is denied, and the URL
   * goes to the person's real browser instead. The canvas's and the
   * debug window are created *here*, in main, by a channel the renderer
   * asks on — not by a renderer opening a URL — so this denial covers
   * every window without an exception in it.
   */
  function denyWindowOpen(window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler((details) => {
      void shell.openExternal(details.url);
      return { action: "deny" };
    });
  }

  /**
   * The main window — the one the app is.
   *
   * Assigned to `mainWindow` by its caller rather than here, so that
   * every path that makes one (`openUserInterface`, `activate`,
   * `showWindow` after a macOS close) goes through the same assignment
   * and none of them can forget it.
   */
  function createWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: 1100,
      height: 720,
      show: false,
      autoHideMenuBar: true,
      // No native title bar: EO's own top row is the title bar (EO-668).
      ...mainWindowChrome(process.platform),
      webPreferences: {
        // Forced to CJS in electron.vite.config.ts: Electron's sandboxed
        // preload loader can't execute ES modules.
        preload: join(mainDir, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Through a transport rather than the window itself (KAN-127): push.ts
    // no longer knows what a window is, and `webContents` is one way of
    // delivering a push rather than the definition of one.
    const stopPushBridge = bridgePushChannels(webContentsTransport(window));
    window.on("closed", () => {
      stopPushBridge();
      // What this window was showing goes with it (EO-192).
      //
      // Not merely tidiness. `view_current` answers from the last publish
      // whenever a window exists, and on macOS closing the window leaves
      // the app running — so reopening it makes `hasWindow()` true again
      // while the new renderer has not published yet, and the tool would
      // describe the *previous* window's screen as though somebody were
      // looking at it. Cleared here, that gap answers "the window has not
      // said what it is showing yet", which is exactly what is true.
      //
      // This handler is the main window's alone. The other windows run
      // none of it: their push bridges are their own.
      clearPublishedView();
      mainWindow = undefined;
      // The popped-out canvas (EO-383) is a window onto this app, not an
      // application of its own. Left open it would be a view beside a
      // conversation that is no longer on screen, and on Windows and
      // Linux it would also hold `window-all-closed` — and so the
      // process — open behind a window the person thought they had quit.
      if (alive(canvasWindow)) canvasWindow.close();
      // And so is the debug window (EO-392), for both reasons.
      if (alive(debugWindow)) debugWindow.close();
    });
    window.on("close", (event) => requestClose?.(event));
    // Full screen has no window controls to leave room for and no title
    // bar to drag (EO-668): the top row is told, and stops reserving the
    // space. The overlay's own geometry is no use for this — on Linux
    // `env(titlebar-area-height)` still answers the overlay's height in full screen.
    window.on("enter-full-screen", () => emitPush("window:changed", {}));
    window.on("leave-full-screen", () => emitPush("window:changed", {}));

    window.on("ready-to-show", () => {
      window.show();
      // Not opened automatically. Docked devtools took ~555px off the
      // window's width on every dev launch — the layout is responsive,
      // but half of it was permanently behind a panel nobody asked for.
      // Toggle it with the standard accelerator (Ctrl/Cmd-Shift-I),
      // or set EO_DEVTOOLS=1 to have it open on launch — detached, so it
      // never takes space from the app it is inspecting.
      //
      // F12 used to be named here beside it. With debug mode on (EO-392)
      // F12 is EO's own: the renderer takes the key and asks for the
      // debug window (`debug/DebugHotkey.tsx`), and Chromium's devtools
      // stay on Ctrl/Cmd-Shift-I. With debug mode off EO does nothing
      // with the key at all, so it does whatever it did before.
      if (isDev && process.env["EO_DEVTOOLS"] === "1") {
        window.webContents.openDevTools({ mode: "detach" });
      }
    });

    denyWindowOpen(window);
    loadRenderer(window);

    return window;
  }

  /**
   * The canvas's window (EO-383): the chat layout's tabbed panel, popped
   * out of the main window so the conversation keeps its full width.
   *
   * An **ordinary** window, deliberately: not always-on-top, so it can
   * be sent behind the main window and recovered from the taskbar like
   * anything else. Everything that differs from the main window is a
   * consequence of there being more than one:
   *
   * - **Its own push bridge and its own disposer.** Closing it stops the
   *   pushes going to it and nothing else; the main window's bridge is
   *   untouched, which it would not be if the two windows shared one.
   * - **It remembers where it was.** See `readBounds`.
   * - **It is not offered `requestClose`.** Closing this window is
   *   closing a window, not asking the process to stop — the shutdown
   *   coordinator hears from the main window and from `before-quit`.
   * - **It is told apart by the URL's query, not by its hash.** A view
   *   is its address, so this window walks between `#/pipelines/…` and
   *   `#/items/…` like the main one does; what makes it the canvas has
   *   to be somewhere a navigation does not rewrite. See
   *   `CANVAS_WINDOW_SEARCH`.
   * - **It is a screen about something, so it does clear the published
   *   view.** While the canvas is out, this is the window that publishes
   *   (`ViewPublisher`), and the main window keeps quiet. When it goes,
   *   what it last said describes a window that is not there — cleared
   *   here, the gap until the main window speaks again answers "the
   *   window has not said what it is showing yet", which is true.
   *
   * `closed` is also where the main window learns the canvas has come
   * back or gone: `canvasWindowClosed` is the one path that "Pop in",
   * "Close the canvas" and the window's own close button all take.
   */
  function createCanvasWindow(path: string): BrowserWindow {
    // A native frame, deliberately, unlike the main window (EO-668). The
    // canvas draws no top row of its own to stand in for a title bar —
    // its tab strip is shared with the main window's canvas, where it is
    // not at the window's edge — and a window somebody pops out has to
    // be movable and closable whatever is open in it.
    const window = new BrowserWindow({
      ...readBounds(canvasBoundsPath(userDataPath), { width: CANVAS_DEFAULT_WIDTH, height: CANVAS_DEFAULT_HEIGHT }),
      minWidth: CANVAS_MIN_WIDTH,
      minHeight: CANVAS_MIN_HEIGHT,
      show: false,
      title: "Canvas",
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(mainDir, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const stopPushBridge = bridgePushChannels(webContentsTransport(window));
    window.on("closed", () => {
      stopPushBridge();
      canvasWindow = undefined;
      clearPublishedView();
      canvasWindowClosed();
    });

    // Written on the way out rather than on every drag. `close` is the
    // last moment the bounds can still be read — `closed` is too late,
    // the native window is gone — and it fires on a quit as well as on a
    // click, which is the other way this window ends.
    window.on("close", () => writeBounds(canvasBoundsPath(userDataPath), window.getNormalBounds()));

    window.on("ready-to-show", () => window.show());

    denyWindowOpen(window);
    loadRenderer(window, path, CANVAS_WINDOW_SEARCH);

    return window;
  }

  /**
   * The debug window (EO-392): what each agent was sent, and what it is
   * doing.
   *
   * Told apart by the URL's query, like the canvas's, and for a simpler
   * reason: it draws no route at all. `App.tsx` reads
   * `DEBUG_WINDOW_SEARCH` before it builds a router, so none of the
   * things that hang off a route — the first-run gate, the chat frame,
   * the view publisher — is in this window to need telling that it
   * should not be.
   *
   * No published view to clear, then, and no `requestClose`: closing it
   * is closing a window. Otherwise built like the canvas's: its own push
   * bridge, its own remembered bounds, closed with the main window.
   */
  function createDebugWindow(): BrowserWindow {
    // A native frame, for the canvas window's reason (EO-668): an
    // instrument window has no top row of EO's to be its title bar.
    const window = new BrowserWindow({
      ...readBounds(debugBoundsPath(userDataPath), { width: DEBUG_DEFAULT_WIDTH, height: DEBUG_DEFAULT_HEIGHT }),
      minWidth: DEBUG_MIN_WIDTH,
      minHeight: DEBUG_MIN_HEIGHT,
      show: false,
      title: "Debug",
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(mainDir, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Its own bridge, which is what makes the activity live: the window
    // hears `runs:progress` and pages the log forward, like any
    // transcript.
    const stopPushBridge = bridgePushChannels(webContentsTransport(window));
    window.on("closed", () => {
      stopPushBridge();
      debugWindow = undefined;
    });

    // On the way out, for the canvas window's reason.
    window.on("close", () => writeBounds(debugBoundsPath(userDataPath), window.getNormalBounds()));

    window.on("ready-to-show", () => window.show());

    denyWindowOpen(window);
    loadRenderer(window, "/", DEBUG_WINDOW_SEARCH);

    return window;
  }

  /**
   * One window's remembered place, put somewhere visible — for whichever
   * window remembers one: the canvas's (EO-383) and the debug window's
   * (EO-392), each in its own file.
   *
   * Persisted to a small file beside the database rather than to a
   * table: it is a fact about *this machine's* windows, it has to be
   * readable before anything has opened the database, and a server —
   * which shares the database in a managed installation — has no windows
   * to have an opinion about.
   *
   * Nothing saved yet means no `x`/`y` at all, which is Electron's own
   * "put it where you would put a new window".
   */
  function readBounds(path: string, fallback: { width: number; height: number }): { x?: number; y?: number; width: number; height: number } {
    const saved = readSavedBounds(path);
    if (saved === null) return fallback;
    return fitOntoAvailableDisplay(
      saved,
      screen.getAllDisplays().map((display) => display.workArea),
    );
  }

  function writeBounds(path: string, bounds: SavedBounds): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(bounds), "utf8");
    } catch {
      // Losing where a window was is not worth a message, and there is
      // nowhere to put one: this runs while the window is closing.
    }
  }

  return {
    async pickDirectory(options) {
      const parent = focusedWindow();
      const dialogOptions = { title: options.title, properties: ["openDirectory" as const, "createDirectory" as const] };
      const result = parent ? await dialog.showOpenDialog(parent, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async pickFile(options) {
      const parent = focusedWindow();
      const dialogOptions = {
        title: options.title,
        properties: options.multiple === true ? ["openFile" as const, "multiSelections" as const] : ["openFile" as const],
        ...(options.filters ? { filters: options.filters } : {}),
      };
      const result = parent ? await dialog.showOpenDialog(parent, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
      return result.canceled ? [] : result.filePaths;
    },
    async saveFile(options) {
      const parent = focusedWindow();
      const dialogOptions = {
        title: options.title,
        ...(options.defaultPath !== undefined ? { defaultPath: options.defaultPath } : {}),
        ...(options.filters ? { filters: options.filters } : {}),
      };
      const result = parent ? await dialog.showSaveDialog(parent, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    openPath: (path) => shell.openPath(path),
    openExternal: (url) => shell.openExternal(url),
    userDataPath,
    keychain: safeStorage,
    notify({ title, body, onClick }) {
      const notification = new Notification({ title, body });
      if (onClick) notification.on("click", onClick);
      notification.show();
    },
    // The *main* window, and not merely any window. This is what
    // `view_current` asks before it describes a screen, and a debug
    // window — which never publishes — open over a closed main window
    // would otherwise answer "yes, somebody is looking" to a question
    // about a screen nobody can see.
    hasWindow: () => alive(mainWindow),
    // A desktop *is* somebody's machine (EO-324, ARCHITECTURE.md, "The record"), and stays one
    // with every window closed: the credentials, the worktrees and the
    // agents are all still here. Nobody is looking; the work goes on.
    hasMachine: true,
    isPackaged: app.isPackaged,
    version: app.getVersion(),

    resources,

    serveIpc() {
      // One door per registered channel, hung from the registry rather
      // than from each call site (EO-318). registerHandler.ts used to do
      // this a channel at a time and was the reason a file in `ipc/`
      // imported Electron; the handler `ipcMain` reaches is now the same
      // `dispatchIpc` the MCP host and every test call, so the renderer
      // cannot come to be answered by a different path than they are.
      for (const channel of registeredChannels()) {
        // The renderer is the person, never an agent (EO-585): only the
        // administrative MCP host says a system agent is the one acting.
        ipcMain.handle(channel, (_event, rawPayload: unknown) => dispatchIpc(channel, withActingAgent(channel, rawPayload, undefined)));
      }
    },

    openUserInterface() {
      mainWindow = createWindow();
      // Registered here rather than at construction, so an `activate`
      // arriving during startup cannot open a window onto handlers that
      // are not registered yet.
      //
      // The condition is "no main window", not "no windows at all": if
      // another window outlives it on macOS, clicking the dock icon has
      // to bring the main window back rather than decide there is
      // already a window and do nothing.
      app.on("activate", () => {
        if (!alive(mainWindow)) mainWindow = createWindow();
      });
    },

    openCanvas(path) {
      if (alive(canvasWindow)) {
        // Raised rather than remade or reloaded: it holds the tabs.
        if (canvasWindow.isMinimized()) canvasWindow.restore();
        canvasWindow.show();
        canvasWindow.focus();
        return true;
      }
      canvasWindow = createCanvasWindow(path);
      return true;
    },
    hasCanvas: () => alive(canvasWindow),

    openDebug() {
      if (alive(debugWindow)) {
        // Raised rather than remade: a second F12 means "show me the one
        // I have", and a new window would lose the tab and the run it
        // was on.
        if (debugWindow.isMinimized()) debugWindow.restore();
        debugWindow.show();
        debugWindow.focus();
        return true;
      }
      debugWindow = createDebugWindow();
      return true;
    },
    isFullScreen: () => alive(mainWindow) && mainWindow.isFullScreen(),
    setTitleBarColours(colours) {
      // macOS draws its own traffic lights, whose colours are the
      // system's; only the overlay on Windows and Linux takes ours.
      if (process.platform === "darwin" || !alive(mainWindow)) return false;
      mainWindow.setTitleBarOverlay(colours);
      return true;
    },
    closeCanvas() {
      if (alive(canvasWindow)) canvasWindow.close();
    },

    async loadAutoUpdater() {
      // electron-updater is CJS and the main bundle is CJS, so the
      // interop shape depends on how the dynamic import is compiled —
      // named on one path, under `.default` on the other. Reading both
      // is the difference between auto-update working and silently
      // never running, which is exactly the failure P-01 warns about.
      const mod = await import("electron-updater");
      const autoUpdater = mod.autoUpdater ?? (mod as unknown as { default?: { autoUpdater?: typeof mod.autoUpdater } }).default?.autoUpdater;
      // The one site where electron-updater's own type meets the slice
      // updater.ts declares. If they ever disagree it is a type error
      // here, which is why that file no longer needs the package.
      return autoUpdater satisfies InjectedUpdater | undefined;
    },

    onBeforeQuit(handler) {
      requestClose = handler;
      app.on("before-quit", handler);
    },
    quit: () => app.quit(),
    exit: (code) => app.exit(code),
    showErrorBox: (title, message) => dialog.showErrorBox(title, message),
    onWake(listener) {
      powerMonitor.on("resume", listener);
      return () => {
        powerMonitor.removeListener("resume", listener);
      };
    },
    sleeps: true,
    isOnline: () => net.isOnline(),

    async askQuestion(question) {
      const messageBox = {
        type: "warning" as const,
        title: question.title,
        message: question.message,
        detail: question.detail,
        buttons: [...question.buttons],
        defaultId: question.defaultIndex,
        // The same index: dismissing the sheet answers what not
        // answering it means, which is the caller's `defaultIndex`.
        cancelId: question.defaultIndex,
        noLink: true,
      };
      const parent = focusedWindow();
      const result = parent ? await dialog.showMessageBox(parent, messageBox) : await dialog.showMessageBox(messageBox);
      return result.response;
    },
    setBadgeCount(count) {
      // Supported on macOS and some Linux desktops; a no-op elsewhere
      // rather than an error.
      app.setBadgeCount?.(count);
    },
    showWindow() {
      // The main window, named rather than taken off the front of
      // `getAllWindows()` — that list is in creation order and would
      // hand back the canvas or the debug window as readily. What asks
      // for this is a notification the person clicked and a second
      // launch of the app, and both of them mean "show me EO".
      if (!alive(mainWindow)) {
        mainWindow = createWindow();
        return;
      }
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    },
  };
}

/** The window a dialog should be modal to: the focused one, else any. */
/**
 * How tall the window controls drawn over EO's top row are (EO-668).
 *
 * The conversation's header and the canvas's tab strip are 52px, the last
 * of which is the rule under them. The controls fill the rest, so they sit
 * in the row rather than above it and the rule runs on under them to the
 * window's edge instead of stopping where the overlay starts.
 */
export const TITLE_BAR_HEIGHT = 51;

/**
 * The main window's narrowest on Windows and Linux (EO-668): the rail
 * (250px), the conversation at its narrowest beside a canvas (16rem) and
 * the canvas at its (6rem and the window controls), with room to spare.
 */
export const MAIN_MIN_WIDTH = 760;

/**
 * The main window's chrome, per platform (EO-668, ARCHITECTURE.md, "Window
 * chrome").
 *
 * No native title bar anywhere: the window manager's bar doubled the
 * chrome above EO's own top row, and on Linux it is drawn in the desktop's
 * theme, which EO cannot colour. The system's window controls stay —
 * nothing here draws buttons of its own.
 *
 * - **macOS**: `hiddenInset`, with the traffic lights moved into the
 *   rail's top inset (`ChatRail`'s spacer, 24px under a 4px pad), level
 *   with the left edge of "EO" below them.
 * - **Windows and Linux**: `hidden` with Electron's title bar overlay,
 *   which draws minimise, maximise and close over the top-right of the
 *   window. Its colours start as the default theme's and follow the
 *   person's from then on (`window:titleBar`); on Linux these are
 *   Electron's buttons rather than the desktop theme's, which was
 *   accepted for an EO-coloured top edge.
 *
 * The renderer makes room for them: `env(titlebar-area-*)` on Windows and
 * Linux, the rail's fixed inset on macOS.
 */
export function mainWindowChrome(
  platform: NodeJS.Platform,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay" | "trafficLightPosition" | "minWidth"> {
  if (platform === "darwin") return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 10 } };
  return {
    // Narrower than this, the rail, a conversation given way to 16rem and
    // a canvas with its two buttons cannot all sit left of the controls
    // (138px on Windows, 96 on Linux): something would be drawn under them.
    minWidth: MAIN_MIN_WIDTH,
    titleBarStyle: "hidden",
    // The Claude theme's rail and muted ink, which is what the window
    // opens in until the renderer says otherwise.
    titleBarOverlay: { color: "#1f1e1d", symbolColor: "#c3c1b8", height: TITLE_BAR_HEIGHT },
  };
}

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

/**
 * The canvas window's sizes (EO-383). It opens wide, because what it
 * draws is a board, and may be made narrow enough to sit beside the
 * conversation on one display.
 */
const CANVAS_MIN_WIDTH = 480;
const CANVAS_MIN_HEIGHT = 360;
const CANVAS_DEFAULT_WIDTH = 1100;
const CANVAS_DEFAULT_HEIGHT = 760;

/**
 * The debug window's sizes (EO-392). Wide, because it is three columns:
 * the runs, what was sent, and what the agent is doing.
 */
const DEBUG_MIN_WIDTH = 720;
const DEBUG_MIN_HEIGHT = 420;
const DEBUG_DEFAULT_WIDTH = 1280;
const DEBUG_DEFAULT_HEIGHT = 820;

/** A window's place, as it is written down between launches. */
export interface SavedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the debug window's place is remembered (EO-392). */
export function debugBoundsPath(userDataPath: string): string {
  return join(userDataPath, "windows", "debug.json");
}

/** Where the canvas window's place is remembered (EO-383). */
export function canvasBoundsPath(userDataPath: string): string {
  return join(userDataPath, "windows", "canvas.json");
}

/**
 * The bounds a previous run wrote, or null.
 *
 * Null for every way this can fail — absent, unreadable, not JSON, JSON
 * of the wrong shape, numbers that are not finite — because there is one
 * sensible response to all of them and it is "open where a new window
 * would open". A file somebody hand-edited into nonsense must not be
 * able to stop a window opening at all.
 */
export function readSavedBounds(path: string): SavedBounds | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    const numbers = (["x", "y", "width", "height"] as const).map((key) => candidate[key]);
    if (!numbers.every((value): value is number => typeof value === "number" && Number.isFinite(value))) return null;
    const [x, y, width, height] = numbers as [number, number, number, number];
    if (width < 1 || height < 1) return null;
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  } catch {
    return null;
  }
}

/** A display's usable area, as `screen.getAllDisplays()` reports it. */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How much of `bounds` a display actually shows. */
function overlap(bounds: SavedBounds, area: WorkArea): number {
  const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const height = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Saved bounds, put somewhere a person can actually reach them.
 *
 * The case this exists for is a laptop undocked: the window was on
 * the second monitor, the second monitor is gone, and the coordinates
 * that used to be a screen are now nowhere. Restored literally, the
 * window opens offscreen — present in the window list, focusable by
 * keyboard, and invisible.
 *
 * The test is "is enough of it visible to be grabbed", not "is it
 * wholly on one display", because a window straddling two monitors is
 * something a person did on purpose and restoring it shifted onto one of
 * them would be EO undoing their arrangement. Half, over all displays
 * together, is the line: above it nothing moves, below it the window is
 * fitted into whichever display shows the most of it — or, when none
 * does, the first one there is.
 *
 * Pure, and exported, so the undocking can be a test rather than a
 * laptop. The `screen` call that feeds it stays in the platform where
 * every other Electron call is.
 */
export function fitOntoAvailableDisplay(bounds: SavedBounds, workAreas: readonly WorkArea[]): SavedBounds {
  if (workAreas.length === 0) return bounds;

  const visible = workAreas.reduce((total, area) => total + overlap(bounds, area), 0);
  if (visible * 2 >= bounds.width * bounds.height) return bounds;

  const best = workAreas.reduce((chosen, area) => (overlap(bounds, area) > overlap(bounds, chosen) ? area : chosen), workAreas[0]!);
  const width = Math.min(bounds.width, best.width);
  const height = Math.min(bounds.height, best.height);
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, best.x), best.x + best.width - width),
    y: Math.min(Math.max(bounds.y, best.y), best.y + best.height - height),
  };
}
