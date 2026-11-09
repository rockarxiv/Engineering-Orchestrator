import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createShutdownCoordinator, type ShutdownChoice, type ShutdownCoordinatorOptions } from "../shutdownCoordinator.js";
import type { UpdateController } from "../updater.js";
import { checkForUpdates, createInstallRequest, downloadUpdate, installUpdate, quitOrInstall, updateStatus, type InstallRequest, type UpdateContext } from "./updateCommands.js";

/**
 * Restarting into an update, through the coordinator rather than around
 * it (EO-201).
 *
 * The assertions here are deliberately on `createShutdownCoordinator`
 * and not on `quitAndInstall`. Spying on `quitAndInstall` would prove
 * only that the binary gets replaced; what has to be true is that it is
 * replaced *by the same path a window close takes*, so that a person
 * with agents running gets the dialog they already know, answered the
 * way it is already answered. A second implementation of that question
 * beside the updater would pass a `quitAndInstall` spy and fail
 * everybody using it.
 */

/** A controller in one fixed state, which is all these tests need of one. */
function controllerIn(staged: boolean) {
  return {
    status: vi.fn(() => (staged ? ({ state: "downloaded", version: "0.5.0", lastCheckedAt: 1 } as const) : ({ state: "idle", lastCheckedAt: null } as const))),
    check: vi.fn(async () => ({ state: "up-to-date", lastCheckedAt: 2 }) as const),
    download: vi.fn(async () => ({ state: "error", message: "connection reset", lastCheckedAt: 2 }) as const),
    isStaged: () => staged,
    installStaged: vi.fn(),
    stop: vi.fn(),
  } satisfies UpdateController;
}

describe("the updates channels", () => {
  it("answers that there is nothing to update when no controller was ever built", async () => {
    const context: UpdateContext = { controller: () => undefined, requestClose: vi.fn(() => true), installRequest: createInstallRequest() };

    expect(updateStatus(context)).toEqual({ state: "unsupported" });
    expect(await checkForUpdates(context)).toEqual({ state: "unsupported" });
    expect(await downloadUpdate(context)).toEqual({ state: "unsupported" });
    // And most importantly it cannot restart anything.
    expect(installUpdate(context)).toEqual({ requested: false });
    expect(context.requestClose).not.toHaveBeenCalled();
  });

  it("passes each half through to the controller", async () => {
    const controller = controllerIn(false);
    const context: UpdateContext = { controller: () => controller, requestClose: vi.fn(() => true), installRequest: createInstallRequest() };

    expect(await checkForUpdates(context)).toEqual({ state: "up-to-date", lastCheckedAt: 2 });
    expect(await downloadUpdate(context)).toEqual({ state: "error", message: "connection reset", lastCheckedAt: 2 });
  });

  it("refuses to request a restart when nothing is staged", () => {
    // The half of the split that matters: `download` left the controller
    // in `error`, so this is the state a failed download is in. It must
    // never reach the coordinator.
    const context: UpdateContext = { controller: () => controllerIn(false), requestClose: vi.fn(() => true), installRequest: createInstallRequest() };

    expect(installUpdate(context)).toEqual({ requested: false });
    expect(context.requestClose).not.toHaveBeenCalled();
  });
});

describe("restarting into a staged update", () => {
  let activeRuns: number;
  let choice: ShutdownChoice;
  let controller: ReturnType<typeof controllerIn>;
  let installRequest: InstallRequest;
  let plainQuit: Mock<() => void>;
  let options: ShutdownCoordinatorOptions;

  beforeEach(() => {
    activeRuns = 0;
    choice = "keep-open";
    controller = controllerIn(true);
    installRequest = createInstallRequest();
    plainQuit = vi.fn<() => void>();
    options = {
      engine: {
        activeRunCount: () => activeRuns,
        beginClose: vi.fn(),
        waitForIdle: vi.fn(async () => undefined),
        shutdown: vi.fn(async () => undefined),
      },
      showActiveRunsDialog: vi.fn(async () => choice),
      persistPause: vi.fn(),
      stopBackgroundServices: vi.fn(),
      // Exactly what startMain.ts wires, because it is the same function.
      quit: quitOrInstall(() => controller, installRequest, plainQuit),
      onStayOpen: () => installRequest.withdraw(),
    };
  });

  function press(coordinator: ReturnType<typeof createShutdownCoordinator>) {
    const context: UpdateContext = { controller: () => controller, requestClose: () => coordinator.requestClose(), installRequest };
    return installUpdate(context);
  }

  it("goes through the coordinator rather than calling quitAndInstall itself", async () => {
    const coordinator = createShutdownCoordinator(options);
    const requestClose = vi.spyOn(coordinator, "requestClose");

    expect(press(coordinator)).toEqual({ requested: true });

    // The assertion the story asks for: the restart was *requested of the
    // coordinator*. Everything downstream — the dialog, the drain, the
    // persisted pause — is the coordinator's, already built and already
    // tested.
    expect(requestClose).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(controller.installStaged).toHaveBeenCalledOnce());
    expect(options.stopBackgroundServices).toHaveBeenCalledOnce();
  });

  it("raises the existing active-agents dialog rather than a second one of its own", async () => {
    activeRuns = 2;
    const coordinator = createShutdownCoordinator(options);

    press(coordinator);

    await vi.waitFor(() => expect(options.showActiveRunsDialog).toHaveBeenCalledOnce());
  });

  it("leaves the update staged but not installed when the answer is keep EO open", async () => {
    activeRuns = 2;
    choice = "keep-open";
    const coordinator = createShutdownCoordinator(options);

    press(coordinator);
    await vi.waitFor(() => expect(options.showActiveRunsDialog).toHaveBeenCalledOnce());

    expect(coordinator.state()).toBe("open");
    expect(controller.installStaged).not.toHaveBeenCalled();
    // Staged, not thrown away: the section still offers the restart, and
    // the next press asks the same question again.
    expect(controller.isStaged()).toBe(true);
    expect(options.engine.beginClose).not.toHaveBeenCalled();
  });

  it("drains first and then installs when the answer is close when finished", async () => {
    activeRuns = 2;
    choice = "close-when-finished";
    const coordinator = createShutdownCoordinator(options);

    press(coordinator);

    await vi.waitFor(() => expect(controller.installStaged).toHaveBeenCalledOnce());
    expect(options.engine.waitForIdle).toHaveBeenCalledOnce();
    expect(options.engine.beginClose).toHaveBeenCalledWith();
    // Graceful, so the persistent preference is untouched — the person is
    // updating, not asking EO to come back paused.
    expect(options.persistPause).not.toHaveBeenCalled();
  });

  it("still persists the pause on the forced path, so a killed process reopens safely", async () => {
    activeRuns = 2;
    choice = "cancel-and-close";
    const coordinator = createShutdownCoordinator(options);

    press(coordinator);

    await vi.waitFor(() => expect(controller.installStaged).toHaveBeenCalledOnce());
    expect(options.persistPause).toHaveBeenCalledOnce();
    expect(options.engine.beginClose).toHaveBeenCalledWith({ cancelRunning: true });
  });

  it("quits plainly when there is no update staged", async () => {
    const quit = vi.fn();
    controller = controllerIn(false);
    const coordinator = createShutdownCoordinator({ ...options, quit: quitOrInstall(() => controller, installRequest, quit) });

    coordinator.requestClose();

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(controller.installStaged).not.toHaveBeenCalled();
  });

  /**
   * EO-696: a downloaded update installs only when *Restart and update*
   * is what led to the quit. Every other way out leaves it on disk.
   */
  it("quits plainly on an ordinary quit with an update downloaded", async () => {
    const coordinator = createShutdownCoordinator(options);

    // A window close, Cmd/Ctrl+Q or the OS: Electron's event, no button.
    coordinator.requestClose({ preventDefault: vi.fn() });

    await vi.waitFor(() => expect(plainQuit).toHaveBeenCalledOnce());
    expect(controller.installStaged).not.toHaveBeenCalled();
    expect(controller.isStaged()).toBe(true);
  });

  it("does not install on a later ordinary quit once the person chose to keep EO open", async () => {
    activeRuns = 2;
    choice = "keep-open";
    const coordinator = createShutdownCoordinator(options);

    expect(press(coordinator)).toEqual({ requested: true });
    await vi.waitFor(() => expect(options.showActiveRunsDialog).toHaveBeenCalledOnce());
    expect(installRequest.isRequested()).toBe(false);

    // Later, the agents have finished and the person closes the window.
    activeRuns = 0;
    coordinator.requestClose({ preventDefault: vi.fn() });

    await vi.waitFor(() => expect(plainQuit).toHaveBeenCalledOnce());
    expect(controller.installStaged).not.toHaveBeenCalled();
  });

  it("installs on a second press after keep-open, once the person goes through with it", async () => {
    activeRuns = 2;
    choice = "keep-open";
    const coordinator = createShutdownCoordinator(options);
    press(coordinator);
    await vi.waitFor(() => expect(options.showActiveRunsDialog).toHaveBeenCalledOnce());

    choice = "cancel-and-close";
    press(coordinator);

    await vi.waitFor(() => expect(controller.installStaged).toHaveBeenCalledOnce());
    expect(plainQuit).not.toHaveBeenCalled();
  });

  it("refuses a press that joins a close already under way, which then quits plainly", async () => {
    activeRuns = 2;
    choice = "close-when-finished";
    let idle!: () => void;
    options.engine.waitForIdle = vi.fn(() => new Promise<void>((resolve) => (idle = resolve)));
    const coordinator = createShutdownCoordinator(options);

    coordinator.requestClose({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(options.engine.waitForIdle).toHaveBeenCalledOnce());

    // The press did not lead to this quit, so it must not turn it into an install.
    expect(press(coordinator)).toEqual({ requested: false });
    expect(installRequest.isRequested()).toBe(false);

    idle();
    await vi.waitFor(() => expect(plainQuit).toHaveBeenCalledOnce());
    expect(controller.installStaged).not.toHaveBeenCalled();
  });

  it("keeps an accepted restart when it is pressed again while agents drain, and installs once", async () => {
    activeRuns = 2;
    choice = "close-when-finished";
    let idle!: () => void;
    options.engine.waitForIdle = vi.fn(() => new Promise<void>((resolve) => (idle = resolve)));
    const coordinator = createShutdownCoordinator(options);

    expect(press(coordinator)).toEqual({ requested: true });
    await vi.waitFor(() => expect(options.engine.waitForIdle).toHaveBeenCalledOnce());

    // The renderer re-enables the button once the first answer arrives.
    // The second press joins the close the first one started, and must
    // not cancel it.
    expect(press(coordinator)).toEqual({ requested: true });
    expect(installRequest.isRequested()).toBe(true);

    idle();
    await vi.waitFor(() => expect(controller.installStaged).toHaveBeenCalledOnce());
    expect(plainQuit).not.toHaveBeenCalled();
    expect(options.showActiveRunsDialog).toHaveBeenCalledOnce();
  });
});
