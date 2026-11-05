import { afterEach, describe, expect, it, vi } from "vitest";
import { PROGRESS_THROTTLE_MS, UPDATE_INTERVAL_MS, startAutoUpdate, startDeferredAutoUpdate, type InjectedUpdater } from "./updater.js";

/**
 * Updating EO, with neither Electron nor a network anywhere near it
 * (EO-201).
 *
 * The injected-`updater` seam is what makes that possible and it is
 * deliberately kept: everything below drives a plain object with an
 * event bag, which is the whole reason a story about a download can be
 * unit-tested at all.
 */

type Listener = (...args: never[]) => void;

/**
 * electron-updater's shape and none of its behaviour.
 *
 * `checkForUpdatesAndNotify` is here despite nothing being allowed to
 * call it — its absence would prove nothing, because a method that does
 * not exist cannot be called by accident either. Present and never
 * invoked is the assertion worth making.
 */
function fakeUpdater() {
  const listeners = new Map<string, Listener[]>();

  const updater = {
    autoDownload: true,
    checkForUpdates: vi.fn().mockResolvedValue(null),
    checkForUpdatesAndNotify: vi.fn().mockResolvedValue(null),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return updater;
    }),
  };

  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) (listener as (...rest: unknown[]) => void)(...args);
  };

  return { updater, emit, injected: updater as unknown as InjectedUpdater };
}

/** Stands in for whatever GH_TOKEN holds; nothing here checks its shape. */
const TOKEN = "gh-token";

/** A clock a test can move by hand, so a throttle assertion is not a race. */
function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("auto-update", () => {
  it("does nothing on an unpackaged build, and says so rather than showing nothing", () => {
    const { updater, injected } = fakeUpdater();
    const log = vi.fn();

    const controller = startAutoUpdate({ isPackaged: false, updater: injected, log });

    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("not a packaged build"));
    // The section needs an answer, not an absence: this is what makes it
    // say "running from source" instead of drawing an empty panel.
    expect(controller.status()).toEqual({ state: "unsupported" });
  });

  it("checks the public release feed at start and on the interval when no token is set (EO-626)", async () => {
    vi.useFakeTimers();
    const { updater, injected } = fakeUpdater();
    const log = vi.fn();

    const controller = startAutoUpdate({ isPackaged: true, updater: injected, log });

    // No token is not a reason to refuse any more: the feed is public,
    // and electron-updater reads it without one.
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("public release feed"));
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(controller.status()).toEqual({ state: "up-to-date", lastCheckedAt: expect.any(Number) });

    controller.stop();
  });

  it("still checks at start and on the interval when a token is set", async () => {
    vi.useFakeTimers();
    const { updater, injected } = fakeUpdater();
    const log = vi.fn();

    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log });

    // electron-updater authenticates with the token itself; this file
    // only says that it will.
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("GitHub token"));
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);

    controller.stop();
  });

  it("downloads nothing on its own, however many times the interval fires", async () => {
    vi.useFakeTimers();
    const { updater, emit, injected } = fakeUpdater();
    // The background path, faithfully: there is a release, and the feed
    // announces it the way electron-updater does — during the check,
    // before its promise settles.
    updater.checkForUpdates.mockImplementation(async () => {
      emit("update-available", { version: "0.5.0" });
      return null;
    });

    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {} });

    // The decision this story exists to make, stated rather than
    // inherited from the library's default of true.
    expect(updater.autoDownload).toBe(false);

    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 2);
    expect(updater.checkForUpdates.mock.calls.length).toBeGreaterThan(1);

    // Nothing was fetched, and nothing was staged behind the person's
    // back to install the next time they quit. Knowing about 0.5.0 and
    // having 0.5.0 on the disk are different things now.
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(controller.status()).toEqual({ state: "available", version: "0.5.0", lastCheckedAt: expect.any(Number) });

    controller.stop();
  });

  it("checks immediately and then on an interval, and never through the notifying variant", async () => {
    vi.useFakeTimers();
    const { updater, injected } = fakeUpdater();

    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {} });

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);

    controller.stop();
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2); // stopped means stopped

    // checkForUpdatesAndNotify raises a native notification saying an
    // update is downloading or ready to install. Neither is true on the
    // background path any more, so the notification would be a lie the
    // person cannot act on.
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
  });

  it("survives a failing check rather than taking the app down with it, and says why", async () => {
    const { updater, injected } = fakeUpdater();
    updater.checkForUpdates.mockRejectedValue(new Error("release server unreachable"));
    const log = vi.fn();

    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log });
    const status = await controller.check();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("release server unreachable"));
    // The failure now has somewhere to be read. This is the state an
    // architecture with no matching artifact surfaces through too.
    expect(status).toEqual({ state: "error", message: "release server unreachable", lastCheckedAt: null });
    controller.stop();
  });

  it("answers up-to-date when there is nothing new, with the time it looked", async () => {
    const time = clock();
    const { emit, injected } = fakeUpdater();
    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {}, now: time.now });

    const checking = controller.check();
    emit("update-not-available", { version: "0.4.0" });
    const status = await checking;

    expect(status).toEqual({ state: "up-to-date", lastCheckedAt: time.now() });
    controller.stop();
  });

  it("settles on up-to-date rather than spinning when the updater announces nothing at all", async () => {
    const { injected } = fakeUpdater();
    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {} });

    // No events, just a resolved promise. Left alone this would leave the
    // section reading "checking" for the life of the process.
    expect((await controller.check()).state).toBe("up-to-date");
    controller.stop();
  });

  it("downloads only when asked, reports progress, and stages the result", async () => {
    const time = clock();
    const onProgress = vi.fn();
    const { updater, emit, injected } = fakeUpdater();
    updater.downloadUpdate.mockImplementation(async () => {
      time.advance(PROGRESS_THROTTLE_MS);
      emit("download-progress", { percent: 40 });
      time.advance(PROGRESS_THROTTLE_MS);
      emit("download-progress", { percent: 90 });
      emit("update-downloaded", { version: "0.5.0" });
      return [];
    });

    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {}, now: time.now, onProgress });

    const checking = controller.check();
    emit("update-available", { version: "0.5.0" });
    await checking;
    expect(updater.downloadUpdate).not.toHaveBeenCalled();

    // Read before the download moves the clock: a download does not
    // re-check, so the last-checked time must survive one unchanged.
    const checkedAt = time.now();
    const status = await controller.download();

    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(status).toEqual({ state: "downloaded", version: "0.5.0", lastCheckedAt: checkedAt });
    expect(controller.isStaged()).toBe(true);
    // Advancing, and ending on the value that settles the readout.
    expect(onProgress.mock.calls.map(([percent]) => percent)).toEqual([0, 40, 90, 100]);

    controller.stop();
  });

  it("throttles progress rather than pushing every chunk at the renderer", async () => {
    const time = clock();
    const onProgress = vi.fn();
    const { updater, emit, injected } = fakeUpdater();
    updater.downloadUpdate.mockImplementation(async () => {
      time.advance(PROGRESS_THROTTLE_MS);
      // A burst inside one window: only the first of these may get out.
      for (const percent of [10, 20, 30, 40]) emit("download-progress", { percent });
      time.advance(PROGRESS_THROTTLE_MS);
      emit("download-progress", { percent: 50 });
      return [];
    });

    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {}, now: time.now, onProgress });
    const checking = controller.check();
    emit("update-available", { version: "0.5.0" });
    await checking;
    await controller.download();

    // 0 is forced at the start of the download, 10 opens the next window
    // and swallows 20/30/40, and 50 arrives once that window has passed.
    // Leading-edge, so the first of a burst is never the one dropped.
    expect(onProgress.mock.calls.map(([percent]) => percent)).toEqual([0, 10, 50]);
    controller.stop();
  });

  it("leaves the app running and stages nothing when a download fails", async () => {
    const { updater, emit, injected } = fakeUpdater();
    updater.downloadUpdate.mockRejectedValue(new Error("connection reset"));
    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {} });

    const checking = controller.check();
    emit("update-available", { version: "0.5.0" });
    await checking;

    const status = await controller.download();

    expect(status).toEqual({ state: "error", message: "connection reset", lastCheckedAt: expect.any(Number) });
    // The half that matters: a failed download must never be able to
    // restart the app.
    expect(controller.isStaged()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    controller.stop();
  });

  it("has nothing to download from a state with nothing available", async () => {
    const { updater, emit, injected } = fakeUpdater();
    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {} });

    const checking = controller.check();
    emit("update-not-available", { version: "0.4.0" });
    await checking;

    expect((await controller.download()).state).toBe("up-to-date");
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    controller.stop();
  });

  it("does not throw a staged update away when the interval comes round again", async () => {
    vi.useFakeTimers();
    const { updater, emit, injected } = fakeUpdater();
    updater.downloadUpdate.mockImplementation(async () => {
      emit("update-downloaded", { version: "0.5.0" });
      return [];
    });
    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {} });

    const checking = controller.check();
    emit("update-available", { version: "0.5.0" });
    await checking;
    await controller.download();

    const checksSoFar = updater.checkForUpdates.mock.calls.length;
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(checksSoFar); // nothing to add
    expect(controller.status()).toEqual({ state: "downloaded", version: "0.5.0", lastCheckedAt: expect.any(Number) });
    controller.stop();
  });

  it("does not orphan a staged update when a stray error arrives after it", async () => {
    const { updater, emit, injected } = fakeUpdater();
    updater.downloadUpdate.mockImplementation(async () => {
      emit("update-downloaded", { version: "0.5.0" });
      return [];
    });
    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {} });

    const checking = controller.check();
    emit("update-available", { version: "0.5.0" });
    await checking;
    await controller.download();

    emit("error", new Error("release server unreachable"));

    // The file is on disk. Saying there is nothing to install would be
    // false, and would lose a restart the person has already been offered.
    expect(controller.isStaged()).toBe(true);
    expect(controller.status().state).toBe("downloaded");
    controller.stop();
  });

  it("installs only when told to, and only through the controller", async () => {
    const { updater, emit, injected } = fakeUpdater();
    updater.downloadUpdate.mockImplementation(async () => {
      emit("update-downloaded", { version: "0.5.0" });
      return [];
    });
    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {} });

    const checking = controller.check();
    emit("update-available", { version: "0.5.0" });
    await checking;
    await controller.download();

    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    controller.installStaged();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    controller.stop();
  });

  it("says so whenever the status moves, so a section already open hears the background check", async () => {
    const onStatusChange = vi.fn();
    const { updater, emit, injected } = fakeUpdater();
    updater.checkForUpdates.mockImplementation(async () => {
      emit("update-available", { version: "0.5.0" });
      return null;
    });

    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {}, onStatusChange });
    await controller.check();

    // idle → checking → available. Nobody asked for any of it, which is
    // exactly why it has to be announced: a Settings section that read
    // `checking` on mount would otherwise draw it forever.
    expect(onStatusChange.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(controller.status().state).toBe("available");
    controller.stop();
  });

  it("announces a check that only moved the time it last looked", async () => {
    const time = clock();
    const onStatusChange = vi.fn();
    const { emit, injected } = fakeUpdater();
    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {}, now: time.now, onStatusChange });

    const first = controller.check();
    emit("update-not-available", { version: "0.4.0" });
    await first;
    onStatusChange.mockClear();

    time.advance(UPDATE_INTERVAL_MS);
    const second = controller.check();
    emit("update-not-available", { version: "0.4.0" });
    await second;

    // Same answer, later. "Last checked" is one of the two lines the
    // section draws, so an unchanged verdict is still a change.
    expect(onStatusChange).toHaveBeenCalled();
    controller.stop();
  });

  it("does not announce once per downloaded chunk", async () => {
    const time = clock();
    const onStatusChange = vi.fn();
    const { updater, emit, injected } = fakeUpdater();
    updater.downloadUpdate.mockImplementation(async () => {
      for (const percent of [10, 20, 30, 40, 50, 60]) emit("download-progress", { percent });
      return [];
    });

    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, updater: injected, log: () => {}, now: time.now, onStatusChange });
    const checking = controller.check();
    emit("update-available", { version: "0.5.0" });
    await checking;
    onStatusChange.mockClear();

    await controller.download();

    // Entering the download and leaving it, and nothing in between:
    // progress is `updates:progress`'s job and it carries the number
    // itself, so a refetch per chunk would be work for a value the
    // renderer already has.
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it("reports a build whose updater could not be loaded without pretending it is running from source", () => {
    const controller = startAutoUpdate({ isPackaged: true, token: TOKEN, log: () => {} });

    // `unsupported` would say "updates apply to installed builds" to
    // somebody running one, which is a dead end with no way out of it.
    expect(controller.status().state).toBe("error");
    expect(controller.isStaged()).toBe(false);
  });
});

/**
 * The window between "the app is running" and "electron-updater has
 * loaded".
 *
 * Nothing filled it before: the controller was assigned inside the
 * import's `then`, so until that resolved the handlers fell back to
 * `unsupported` — telling somebody on an installed build that they were
 * running from source. And the import had no rejection handler at all,
 * so a failure left that fallback standing permanently, with an
 * unhandled rejection behind it.
 */
describe("loading the updater", () => {
  const deferred = () => {
    let settle!: (updater: InjectedUpdater | undefined) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<InjectedUpdater | undefined>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    return { promise, settle, fail };
  };

  it("answers truthfully while the module is still loading, and never `unsupported`", async () => {
    const load = deferred();
    const { injected } = fakeUpdater();

    const updates = startDeferredAutoUpdate({
      deps: { isPackaged: true, token: TOKEN, log: () => {} },
      load: () => load.promise,
      onReplaced: () => {},
    });

    // The whole point: an installed build must not claim to be running
    // from source just because a dynamic import has not resolved yet.
    expect(updates.current().status().state).toBe("error");
    expect(updates.current().status().state).not.toBe("unsupported");

    load.settle(injected);
    await vi.waitFor(() => expect(updates.current().status().state).not.toBe("error"));
    updates.current().stop();
  });

  it("starts checking once the module arrives even with no token", async () => {
    const load = deferred();
    const { updater, injected } = fakeUpdater();

    const updates = startDeferredAutoUpdate({
      deps: { isPackaged: true, log: () => {} },
      load: () => load.promise,
    });

    expect(updates.current().status().state).toBe("error");

    load.settle(injected);
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledOnce());
    updates.current().stop();
  });

  it("installs an error controller when the import rejects, rather than leaving none", async () => {
    const log = vi.fn();
    const onReplaced = vi.fn();

    const updates = startDeferredAutoUpdate({
      deps: { isPackaged: true, token: TOKEN, log },
      load: () => Promise.reject(new Error("cannot find module 'electron-updater'")),
      onReplaced,
    });

    await vi.waitFor(() => expect(onReplaced).toHaveBeenCalledOnce());

    // Handled, said out loud, and still not `unsupported`.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cannot find module"));
    expect(updates.current().status().state).toBe("error");
    expect(updates.current().isStaged()).toBe(false);
  });

  it("loads nothing at all on an unpackaged build", () => {
    const load = vi.fn(() => Promise.resolve(undefined));

    const updates = startDeferredAutoUpdate({ deps: { isPackaged: false, log: () => {} }, load });

    expect(load).not.toHaveBeenCalled();
    expect(updates.current().status()).toEqual({ state: "unsupported" });
  });

  it("stops the placeholder's timer when it replaces it", async () => {
    vi.useFakeTimers();
    const { updater, injected } = fakeUpdater();
    const updates = startDeferredAutoUpdate({
      deps: { isPackaged: true, token: TOKEN, log: () => {} },
      load: () => Promise.resolve(injected),
    });

    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalled());
    // Exactly one checker running, not two racing each other.
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);

    updates.current().stop();
  });
});
