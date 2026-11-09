import type { UpdateStatus } from "@eo/core";

/**
 * The slice of electron-updater this file drives, and the whole of it.
 *
 * Injected so the checker is testable without Electron and without a
 * network — the seam predates this story and is kept deliberately.
 *
 * Written out structurally rather than as `Pick<AppUpdater, …>`
 * (EO-318). This file names no Electron package any more: the one place
 * that does is `platform/electron.ts`, whose `loadAutoUpdater` assigns
 * the real `autoUpdater` to this type — so the conformance is still
 * checked by the compiler, at exactly one site, and a drift between
 * what electron-updater offers and what this file expects is a type
 * error there rather than a lie here.
 *
 * Only the six events `startAutoUpdate` subscribes to are declared.
 * Listing them by name is the point: an event this file does not handle
 * is not part of the slice, and a second implementation of `Platform`
 * has a short and complete list of what it must emit.
 */
export interface InjectedUpdater {
  /** Assigning it is the point — see the note on `startAutoUpdate` below. */
  autoDownload: boolean;
  /** Assigned `false`: a quit never installs by itself (EO-696). */
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "checking-for-update", listener: () => void): unknown;
  on(event: "update-not-available", listener: () => void): unknown;
  on(event: "update-available", listener: (info: { version: string }) => void): unknown;
  on(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  on(event: "update-downloaded", listener: (event: { version: string }) => void): unknown;
}

export interface UpdaterDeps {
  isPackaged: boolean;
  /** Injected so this is testable without Electron or a network. */
  updater?: InjectedUpdater;
  /**
   * GH_TOKEN or GITHUB_TOKEN, if either is set. Optional: the release
   * feed is public and is read without one. electron-updater picks the
   * variable up for itself and authenticates with it (see `publish` in
   * electron-builder.yml); it is passed here only so the startup log can
   * say which way the feed is being read. Passed in rather than read
   * here so a test can describe an environment without being run in one.
   */
  token?: string | undefined;
  log?: (message: string) => void;
  /**
   * Where a download's progress goes — `emitPush("updates:progress")` in
   * the app, nothing in a test. Throttled here rather than at the call
   * site so the throttle is covered by this file's tests, which need
   * neither Electron nor a window to run.
   */
  onProgress?: (percent: number) => void;
  /**
   * Told whenever the status changes — `emitPush("updates:changed")` in
   * the app.
   *
   * Without it the six-hourly check would be invisible to a section
   * already open: the background path moves the status with nobody
   * having asked, and a renderer that only ever asked once would still
   * be drawing the answer it got when it mounted.
   */
  onStatusChange?: () => void;
  /** Injected so a test can assert on a fixed last-checked time. */
  now?: () => number;
}

/**
 * What the rest of the main process can ask this file, rather than only
 * read in a log.
 *
 * `check` and `download` are separate because a failed download must not
 * be able to restart the app, and `installStaged` is separate from both
 * because restarting is the shutdown coordinator's job — see the note on
 * it below.
 */
export interface UpdateController {
  status: () => UpdateStatus;
  /** Look now. Resolves to the state the check left behind. */
  check: () => Promise<UpdateStatus>;
  /** Fetch the available release. Resolves when it has finished or failed. */
  download: () => Promise<UpdateStatus>;
  /** Whether a downloaded update is sitting on disk waiting for a restart. */
  isStaged: () => boolean;
  /**
   * Replace this build silently and relaunch. Called from exactly one
   * place — the shutdown coordinator's `quit` callback, and only when the
   * person pressed *Restart and update* — and never from an IPC handler;
   * see the block comment on `startAutoUpdate`.
   */
  installStaged: () => void;
  stop: () => void;
}

/** How often to look. Long enough to be invisible, short enough that a fix lands the same day. */
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How often a download's progress is allowed to reach the renderer.
 *
 * electron-updater emits `download-progress` per chunk, which on a fast
 * connection is hundreds of times a second. A progress readout redrawn
 * more often than a frame is drawn is work nobody can see.
 */
export const PROGRESS_THROTTLE_MS = 250;

/** A controller for a build that will never update, answering the reason forever. */
function inert(status: UpdateStatus): UpdateController {
  return {
    status: () => status,
    check: () => Promise.resolve(status),
    download: () => Promise.resolve(status),
    isStaged: () => false,
    installStaged: () => {},
    stop: () => {},
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Auto-update against GitHub Releases (P-01), which as of EO-201 no
 * longer downloads anything by itself.
 *
 * The six-hourly check stays: checking is cheap, and it is what lets
 * Settings say *0.5.0 is available* without having been opened first.
 * What went is the download behind it. `autoDownload` was never assigned
 * here, so it ran on electron-updater's default of `true` — a release
 * fetched in the background and installed the next time you quit, which
 * for an app whose job is long agent sessions means the binary changed
 * while you were not looking. Assigning it `false` is the smallest
 * change in this file and the one that changes the most.
 *
 * `checkForUpdates` rather than `checkForUpdatesAndNotify` for the same
 * reason: the latter raises a native notification saying an update is
 * downloading or ready to install, and neither is true any more.
 *
 * **Restarting is not done here.** `quitAndInstall` is exposed on the
 * controller and called from exactly one place — the shutdown
 * coordinator's `quit` callback. The coordinator owns every path out of
 * the process and already asks the active-agents question, so routing
 * the update restart through it means the button inherits the dialog,
 * the drain and the persisted pause for free rather than growing a
 * second implementation of a question already answered.
 *
 * Two things worth knowing:
 *
 * Windows x64 and arm64 are separate channels. electron-updater matches
 * the *installed* architecture against the published artifacts, so an
 * arm64 machine running an x64 build finds no matching update and simply
 * never updates — silently, which is the trap this story calls out. The
 * fix is on the publish side (build and publish both arches), and this
 * checker is only correct because of it. What EO-201 adds is somewhere
 * for it to be *said*: the `error` state reaches the Updates section
 * instead of a log line.
 *
 * Disabled entirely when unpackaged: a dev build has no version to
 * compare against a release, and electron-updater throws rather than
 * shrugging.
 *
 * A token is not required (EO-626). Without one electron-updater reads
 * the public releases feed; with GH_TOKEN or GITHUB_TOKEN set it reads
 * the same releases through the API as that user. Either way the check
 * below runs the same.
 */
export function startAutoUpdate(deps: UpdaterDeps): UpdateController {
  const log = deps.log ?? ((message: string) => console.log(`[eo] ${message}`));
  const now = deps.now ?? (() => Date.now());

  if (!deps.isPackaged) {
    log("auto-update disabled: not a packaged build");
    return inert({ state: "unsupported" });
  }

  const updater = deps.updater;
  if (!updater) {
    log("auto-update disabled: no updater available");
    // Not `unsupported`: this *is* an installed build, and saying
    // "updates apply to installed builds" to somebody running one would
    // be a lie with no way out of it.
    return inert({ state: "error", message: "The updater could not be loaded, so this build cannot check for updates.", lastCheckedAt: null });
  }

  log(deps.token ? "checking for updates with the GitHub token from the environment" : "checking for updates from the public release feed");

  // The whole point of the story, stated rather than inherited. Nothing
  // reaches the disk until `download()` is called, which happens only
  // when somebody presses the button.
  updater.autoDownload = false;
  // And nothing downloaded installs by itself either (EO-696). Left at
  // electron-updater's default of `true`, any quit with an update on
  // disk would install it; the only install is the one `installStaged`
  // asks for.
  updater.autoInstallOnAppQuit = false;

  let lastCheckedAt: number | null = null;
  let status: UpdateStatus = { state: "idle", lastCheckedAt: null };
  let lastProgressAt: number | null = null;

  const set = (next: UpdateStatus): UpdateStatus => {
    const previous = status;
    status = next;

    // Progress churn is `updates:progress`'s business, and it carries the
    // percentage itself. Saying "this changed, ask again" per downloaded
    // chunk would have the renderer refetch hundreds of times for a
    // number it has already been handed.
    if (previous.state === "downloading" && next.state === "downloading") return next;

    // Compared by value rather than by discriminator: a check that finds
    // the same answer still moves `lastCheckedAt`, and *when EO last
    // looked* is one of the two lines the section draws.
    if (JSON.stringify(previous) !== JSON.stringify(next)) deps.onStatusChange?.();
    return next;
  };

  /**
   * Reads the current state through a call rather than the binding.
   *
   * The listeners below assign `status` while a promise is in flight —
   * that is the design, since `download-progress` and `update-downloaded`
   * arrive as events and nothing else knows about them. Reading the
   * binding directly after an `await` lets TypeScript narrow from the
   * value it had *before*, which is reasoning about a state that has
   * since moved on.
   */
  const read = (): UpdateStatus => status;

  /** Leading-edge throttle. 100% is always let through, because it is the one that settles the readout. */
  const pushProgress = (percent: number, force = false): void => {
    if (!deps.onProgress) return;
    const at = now();
    if (!force && lastProgressAt !== null && at - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = at;
    deps.onProgress(percent);
  };

  updater.on("error", (error: Error) => {
    // Never fatal. A failed update check must not take the app down —
    // the user's agents are mid-run and an unreachable release server is
    // not their problem. It is no longer only logged, though: the
    // section is where somebody asking the question can read it.
    log(`update check failed: ${error.message}`);
    // Never over a staged update. The file is already on disk, and an
    // error arriving after it would orphan it — `isStaged()` would start
    // saying there is nothing to install while there plainly is.
    if (read().state === "downloaded") return;
    set({ state: "error", message: error.message, lastCheckedAt });
  });

  updater.on("checking-for-update", () => set({ state: "checking", lastCheckedAt }));

  updater.on("update-not-available", () => {
    lastCheckedAt = now();
    set({ state: "up-to-date", lastCheckedAt });
  });

  updater.on("update-available", (info) => {
    lastCheckedAt = now();
    log(`update available: ${info.version} (nothing will be downloaded until it is asked for)`);
    set({ state: "available", version: info.version, lastCheckedAt });
  });

  updater.on("download-progress", (info) => {
    const percent = Math.min(100, Math.max(0, info.percent));
    set({ state: "downloading", percent, lastCheckedAt });
    pushProgress(percent);
  });

  updater.on("update-downloaded", (event) => {
    log(`update ${event.version} downloaded; it will install when Restart and update is pressed`);
    set({ state: "downloaded", version: event.version, lastCheckedAt });
    pushProgress(100, true);
  });

  const check = async (): Promise<UpdateStatus> => {
    // A check while a download is in flight, or over one already staged,
    // would throw away the more interesting state for a less interesting
    // one. The interval keeps ticking; it just has nothing to add here.
    if (read().state === "downloading" || read().state === "downloaded") return read();

    set({ state: "checking", lastCheckedAt });
    try {
      await updater.checkForUpdates();
    } catch (error) {
      const message = messageOf(error);
      log(`update check failed: ${message}`);
      return set({ state: "error", message, lastCheckedAt });
    }

    // electron-updater announces the answer through `update-available` /
    // `update-not-available`, and both land before the returned promise
    // settles — so by here the state is usually already right. If neither
    // fired, the check completed having found nothing, and saying so
    // beats leaving the section spinning on `checking` forever.
    if (read().state === "checking") {
      lastCheckedAt = now();
      return set({ state: "up-to-date", lastCheckedAt });
    }
    return read();
  };

  const download = async (): Promise<UpdateStatus> => {
    // Only ever from `available`. Downloading again over something
    // already staged re-fetches for no reason, and there is nothing to
    // fetch from any other state — each of which is its own answer the
    // caller should get back unchanged rather than a thrown error.
    const available = read();
    if (available.state !== "available") return available;

    const { version } = available;
    set({ state: "downloading", percent: 0, lastCheckedAt });
    pushProgress(0, true);

    try {
      await updater.downloadUpdate();
    } catch (error) {
      const message = messageOf(error);
      log(`update download failed: ${message}`);
      // The app keeps running and nothing restarts. The section reads
      // this and offers to try again.
      return set({ state: "error", message, lastCheckedAt });
    }

    // As with `check`, the `update-downloaded` event normally got here
    // first. This is the fallback for an updater that resolves without
    // announcing, so a finished download cannot look like a stuck one.
    if (read().state === "downloading") {
      return set({ state: "downloaded", version, lastCheckedAt });
    }
    return read();
  };

  void check();
  const timer = setInterval(() => void check(), UPDATE_INTERVAL_MS);
  timer.unref?.();

  return {
    status: read,
    check,
    download,
    isStaged: () => read().state === "downloaded",
    installStaged: () => {
      log("installing the downloaded update and restarting");
      // Silent, and reopen EO afterwards. With no arguments the Windows
      // installer — `oneClick: false` — opens its full wizard and EO
      // does not come back (EO-696).
      updater.quitAndInstall(true, true);
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * A controller for a packaged build whose updater arrives later.
 *
 * electron-updater is loaded through a dynamic import, so there is a
 * window between "the app is running" and "there is an updater to run".
 * Something has to answer `updates:status` during it, and the answer
 * must not be `unsupported` — that means *this is running from source*,
 * which said to somebody on an installed build is both false and a dead
 * end offering them no button.
 *
 * So the window is filled by a controller built from the same deps minus
 * the module, which on a packaged build is an error naming the real
 * problem. It is built silently,
 * because it is a placeholder rather than an event — whichever
 * controller ends up standing does its own logging.
 *
 * Both settlements of the import replace it, the rejection included. An
 * import that throws must not leave the app with an unhandled rejection
 * and a controller that never arrives, which is how an installed build
 * came to claim it was running from source.
 *
 * `load` is injected for the same reason `updater` is: this file stays
 * testable without Electron, without a bundler and without the module
 * actually being there.
 */
export function startDeferredAutoUpdate(options: {
  deps: UpdaterDeps;
  load: () => Promise<InjectedUpdater | undefined>;
  /** Called once the real controller stands, so the renderer re-asks. */
  onReplaced?: () => void;
}): { current: () => UpdateController } {
  const { deps, load, onReplaced } = options;
  const log = deps.log ?? ((message: string) => console.log(`[eo] ${message}`));

  let controller = startAutoUpdate({ ...deps, log: () => {} });

  // Nothing to load and nothing to wait for: the placeholder is already
  // the final answer, and it is `unsupported` because that is the truth.
  if (!deps.isPackaged) return { current: () => controller };

  const replace = (updater: InjectedUpdater | undefined): void => {
    controller.stop();
    controller = startAutoUpdate(updater ? { ...deps, updater } : deps);
    onReplaced?.();
  };

  void load().then(replace, (error: unknown) => {
    log(`could not load the updater: ${messageOf(error)}`);
    // Deliberately still through `startAutoUpdate`, so the reason it
    // reports is the same one the placeholder gave: the module is what
    // is missing.
    replace(undefined);
  });

  return { current: () => controller };
}
