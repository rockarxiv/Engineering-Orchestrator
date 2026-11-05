import type { ResourcePaths } from "../resources.js";
import type { SecretStore } from "../secrets/store.js";
import type { InjectedUpdater } from "../updater.js";
import type { DeviceDirectory, WebhookDoor } from "../server/http.js";

/**
 * What the composition root can hand a door it does not own (EO-323,
 * EO-328).
 *
 * One object rather than a growing list of optional positions: every
 * member is a fact about *the record this process is*, assembled by
 * `startMain` because it is the only thing holding the database and the
 * platform at once, and every one is ignored by the desktop for the same
 * reason — its door is its own window.
 */
export interface IpcDoor {
  devices?: DeviceDirectory;
  /** Read afresh on every request, so a value an admin cleared is not still handed out. */
  organisationSecrets?: () => Record<string, string>;
  /**
   * What a webhook delivery becomes (EO-332, ARCHITECTURE.md, "Webhooks").
   *
   * The third such fact, and the one with the clearest reason to be a
   * fact about the record rather than about the transport: a delivery is
   * verified against a job's secret, deduplicated against a job's past
   * events and capped by a job's items-per-hour, and none of those exist
   * on a machine that is nobody's record. A desktop ignores it, which is
   * the design's own sentence — a webhook always arrives at the server,
   * because only the server has a public address.
   */
  webhooks?: WebhookDoor;
}

/**
 * What the machine provides that the handlers cannot do for themselves
 * (KAN-127, ARCHITECTURE.md, "Where the seams are").
 *
 * handlers.ts used to make twenty-three direct Electron calls — dialogs,
 * `shell`, `app.getPath`, `safeStorage`, `BrowserWindow` — which meant
 * the one file that registers every channel could only be loaded inside
 * Electron. This is the seam those calls now go through: the Electron
 * implementation lives in `../platform/electron.ts` and is handed in by
 * the composition root, and a headless main implements the same members
 * a second time, or answers "there is nobody here to click" where a
 * member has no honest meaning without a window.
 *
 * `hasWindow` is the one member the story's original list did not name.
 * It is here because `view:current` asked `BrowserWindow` the question
 * directly, and the answer is a fact about the machine like the rest —
 * a headless main says no and the tool answers that nobody is looking at
 * a screen, which is true.
 *
 * **EO-318 finished what KAN-127 started.** The interface was the
 * handlers' view of the machine; it is now the *whole* main process's
 * view of it. `startMain` composes the app — database, engine, packs,
 * schedulers, MCP hosts — out of nothing but this, so the members below
 * that no handler ever calls (`serveIpc`, `openUserInterface`,
 * `onBeforeQuit`, `quit`, `exit`, `askQuestion`, `showErrorBox`,
 * `setBadgeCount`, `showWindow`, `resources`, `loadAutoUpdater`) are
 * here because they are the last Electron calls in the process and this
 * is where a second implementation answers them.
 *
 * `ipcMain` is still deliberately *not* on it, and for the same reason
 * as before: it is a door rather than a capability. What changed is that
 * the door is now opened in one place — `serveIpc`, from the same
 * `dispatchIpc` the MCP host uses — instead of once per channel inside
 * `registerHandler`.
 */
export interface Platform {
  /**
   * Native directory picker, modal to the person's window. `null` when
   * they cancelled.
   */
  pickDirectory(options: { title: string }): Promise<string | null>;
  /**
   * Native file picker. Empty when they cancelled; never more than one
   * path unless `multiple` was asked for.
   */
  pickFile(options: { title: string; filters?: FileFilter[]; multiple?: boolean }): Promise<string[]>;
  /** Native save dialog. `null` when they cancelled. */
  saveFile(options: { title: string; defaultPath?: string; filters?: FileFilter[] }): Promise<string | null>;
  /**
   * Opens a path in whatever the OS uses for it. Resolves to `""` when
   * it opened and to the OS's own message when it did not — the shape
   * `shell.openPath` answers with, kept so the caller can pass the
   * sentence on rather than translate it.
   */
  openPath(path: string): Promise<string>;
  /** Opens a URL in the person's real browser. */
  openExternal(url: string): Promise<void>;
  /** Where this installation keeps its state — `app.getPath("userData")` under Electron. */
  readonly userDataPath: string;
  /** The OS keychain, as the one slice of it EO's secret files need. */
  readonly keychain: SecretStore;
  /**
   * A desktop notification. `onClick` is what the person asked for by
   * clicking it, when the platform can tell.
   */
  notify(notification: { title: string; body: string; onClick?: () => void }): void;
  /**
   * Whether there is a window somebody could be looking at. What
   * `view:current` asks before describing a screen.
   *
   * The desktop can have several, and this means **the main one** — the
   * window the app is. The canvas's and the debug window close with it,
   * and neither counts on its own.
   */
  hasWindow(): boolean;
  /**
   * Puts the canvas in a window of its own, at `path`, and answers
   * whether there is one (EO-383).
   *
   * The same renderer in a second real window under Electron, and
   * nothing at all on a host with no screen, which answers `false`: a
   * caller learns that no window opened rather than assuming one did.
   *
   * Idempotent — a canvas window that already exists is raised rather
   * than duplicated, and is *not* reloaded at `path`, because it holds
   * tabs a reload would throw away. Sending an open window somewhere is
   * a push (`canvas:opened`), which is `ipc/canvasWindow.ts`'s business.
   */
  openCanvas(path: string): boolean;
  /**
   * Puts the debug window in front of the person, and answers whether
   * anything appeared (EO-392).
   *
   * The canvas window's sibling, and built like it: the same renderer
   * in a real window of its own under Electron, `false` on a host with
   * no screen, and idempotent — a debug window that already exists is
   * raised and focused rather than duplicated, which is what a second
   * F12 asks for.
   *
   * Whether debug mode is on is not this member's question. The handler
   * that serves `debug:window` asks the setting first; the platform
   * opens windows and has no opinion about when.
   *
   * On the interface rather than reached directly, for the reason every
   * other member is: `new BrowserWindow` may be written in exactly one
   * file, and the handlers that serve `canvas:window` and `debug:window`
   * are not it.
   */
  openDebug(): boolean;
  /** Whether the canvas has a window of its own right now. */
  hasCanvas(): boolean;
  /**
   * Closes the canvas's window, if there is one. Nothing otherwise.
   *
   * What happens next is the same whoever closed it — this, or the
   * person pressing the window's own close: the platform tells
   * `ipc/canvasWindow.ts`, which tells the main window.
   */
  closeCanvas(): void;
  /**
   * Whether this process has a machine to run work on (EO-324,
   * `ARCHITECTURE.md`, "The record").
   *
   * The record/device split in one boolean. A **device** is the machine
   * the work actually happens on — somebody's laptop, their login to
   * Claude or Codex, their files — and the original design is unambiguous about where
   * that is: *"work runs on the person's machine. The server never
   * needs the person's disk."*
   *
   * A server has none of it. It is the record: it owns item state, it
   * runs the only scheduler, and it leases dispatches to the devices
   * that ask. If it also ran a device loop it would be a third
   * contender for every lease — one that always wins, because its
   * record is in the same process and answers with no network in the
   * way — and it would win only to refuse at preflight, since there is
   * no backend signed in on it. Every item would be claimed, refused,
   * commented on and released, over and over.
   *
   * Distinct from `hasWindow`, and the distinction is load-bearing: a
   * desktop with every window closed still has a machine, still holds
   * the person's credentials and still runs their agents. Nobody is
   * looking; the work goes on.
   *
   * It is the same fact the machine half of the contract already turns
   * on — `isMachineChannel` is refused on a server because there is no
   * machine there to answer — said where the composition root can read
   * it.
   */
  readonly hasMachine: boolean;
  /** A packaged build hides error details from the renderer; a development one shows them. */
  readonly isPackaged: boolean;
  /** The version this process reports, for `app:getVersion`. */
  readonly version: string;

  // ─── What only the composition root asks (EO-318) ───

  /**
   * Where the files that ship beside the bundle are — migrations,
   * prompts, the MCP and module scripts, the bundled gallery.
   *
   * Resolved by the platform because the answer is a fact about how this
   * build was packaged: Electron reads `process.resourcesPath` and the
   * directory the main bundle was loaded from, and neither exists for a
   * server binary laid out its own way. Read once, at construction, the
   * way `userDataPath` and `version` are.
   */
  readonly resources: ResourcePaths;
  /**
   * Opens the door this platform's clients reach the handlers through,
   * once every channel has been registered.
   *
   * Electron attaches `ipcMain` to `dispatchIpc`; that is the whole of
   * what registerHandler.ts used to do per channel, moved to one place
   * and pointed at the registry so the renderer's door and the MCP
   * host's are the same door. Called exactly once, and after
   * `registerAllHandlers` — a request arriving earlier would find the
   * registry empty.
   *
   * `devices` is how a door that authenticates learns who is knocking
   * (EO-323): the organisation's device list, built over SQLite by the
   * composition root, because `startMain` is the only thing that has the
   * database and the platform in the same hand. Electron's
   * implementation ignores it — the renderer is this process's own
   * window, and a token between a process and its own window would be a
   * lock whose key is in the same drawer.
   *
   * `organisationSecrets` is the second such fact (EO-328): what a
   * server hands a signed-in device over `ORGANISATION_SECRETS_PATH`,
   * which is a route rather than a channel and so cannot be registered
   * with the handlers. Electron ignores this one too, and for a sharper
   * reason than the first: a desktop is not anybody's record, so it has
   * no organisation secrets of its own to hand out — it *receives* them.
   */
  serveIpc(door?: IpcDoor): void;
  /**
   * Opens whatever surface a person looks at, now that the process can
   * answer them. A window under Electron; nothing at all on a host with
   * no screen.
   *
   * Last, and for the reason `serveIpc` is second-to-last: a renderer
   * invokes IPC the moment it loads.
   */
  openUserInterface(): void;
  /**
   * Whatever this platform uses to replace itself, when it has one.
   *
   * `undefined` for a platform that is updated by something other than
   * itself — a server under a package manager, a test. Loaded lazily
   * because under Electron it is a dynamic import of a CJS module, and
   * the app answers `updates:status` before it has arrived.
   */
  loadAutoUpdater(): Promise<InjectedUpdater | undefined>;
  /**
   * Registers the one handler that runs when something asks this process
   * to stop — a window closing, the application menu, an OS session
   * request, a signal.
   *
   * The handler may `preventDefault()` to hold the exit open while it
   * drains, which is what the shutdown coordinator does. Called once.
   */
  onBeforeQuit(handler: (event: { preventDefault: () => void }) => void): void;
  /** Ends the process the orderly way, once the coordinator has finished with it. */
  quit(): void;
  /**
   * Ends the process *now*, with a status, because it cannot usefully
   * continue — a failed migration and nothing else today.
   */
  exit(code: number): void;
  /**
   * A message the person has to acknowledge before the process gives up,
   * shown without a renderer because there may not be one yet.
   */
  showErrorBox(title: string, message: string): void;
  /**
   * Calls `listener` each time the computer wakes from sleep, until the
   * returned function is called.
   *
   * What the inactivity guard is told so that time asleep is not counted
   * as a run's silence (`RunSupervisorOptions.onWake`). A server never
   * sleeps, and its implementation never calls.
   */
  onWake(listener: () => void): () => void;
  /**
   * Whether the machine sleeps (EO-514). A desktop does; a server does
   * not.
   *
   * What decides whether a late watchdog pass holds every watch for a
   * minute (`RunSupervisorOptions.sleeps`). On a desktop a pass that
   * comes long after it was due is a wake, and the network is often not
   * back yet. On a server it is a paused container or a stalled event
   * loop: its network never went anywhere, and holding the watches would
   * only delay them.
   */
  readonly sleeps: boolean;
  /**
   * Whether the machine can reach the network right now.
   *
   * What holds every step that keeps checking while it says no, so that
   * an outage does not count as the checks failing
   * (`RunSupervisorOptions.isOnline`, EO-457). Electron's
   * `net.isOnline()` on a desktop. A server treats itself as always
   * online: it has nobody to tell, and a host whose network is down is
   * one its operator is already looking at.
   */
  isOnline(): boolean;
  /**
   * Asks the person to choose between named buttons, modal to their
   * window, and answers with the index they chose.
   *
   * `null` when there is nobody to ask — a host with no screen — and the
   * caller decides what silence means rather than this returning a guess
   * on its behalf.
   */
  askQuestion(question: {
    title: string;
    message: string;
    detail: string;
    buttons: readonly string[];
    /** Chosen when the person dismisses the question rather than answering it. */
    defaultIndex: number;
  }): Promise<number | null>;
  /**
   * How many things are waiting for the person, on whatever the platform
   * puts a number on. A no-op where there is nothing to badge.
   */
  setBadgeCount(count: number): void;
  /**
   * Brings the person's window to the front — what clicking a
   * notification asks for before the push that navigates it.
   */
  showWindow(): void;
}

/** One entry of a native dialog's file-type filter. */
export interface FileFilter {
  name: string;
  extensions: string[];
}
