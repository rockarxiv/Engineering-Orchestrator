import { beforeEach, describe, expect, it, vi } from "vitest";
import { createShutdownCoordinator, type ShutdownChoice, type ShutdownCoordinatorOptions } from "./shutdownCoordinator.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("shutdown coordinator", () => {
  let activeRuns: number;
  let choice: ShutdownChoice;
  let idle: ReturnType<typeof deferred>;
  let options: ShutdownCoordinatorOptions;

  beforeEach(() => {
    activeRuns = 2;
    choice = "keep-open";
    idle = deferred();
    options = {
      engine: {
        activeRunCount: () => activeRuns,
        beginClose: vi.fn(),
        waitForIdle: vi.fn(() => idle.promise),
        shutdown: vi.fn(async () => undefined),
      },
      showActiveRunsDialog: vi.fn(async () => choice),
      persistPause: vi.fn(),
      stopBackgroundServices: vi.fn(),
      quit: vi.fn(),
    };
  });

  function close(coordinator: ReturnType<typeof createShutdownCoordinator>) {
    const event = { preventDefault: vi.fn() };
    coordinator.requestClose(event);
    return event;
  }

  it("closes immediately without warning when no agents are active", async () => {
    activeRuns = 0;
    const coordinator = createShutdownCoordinator(options);

    expect(close(coordinator).preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(options.quit).toHaveBeenCalledOnce());

    expect(options.showActiveRunsDialog).not.toHaveBeenCalled();
    expect(options.engine.beginClose).toHaveBeenCalledWith();
    expect(options.stopBackgroundServices).toHaveBeenCalledOnce();
  });

  it("Keep EO open changes no pause, cancellation, or close state", async () => {
    const coordinator = createShutdownCoordinator(options);
    close(coordinator);
    await vi.waitFor(() => expect(options.showActiveRunsDialog).toHaveBeenCalledOnce());

    expect(coordinator.state()).toBe("open");
    expect(options.engine.beginClose).not.toHaveBeenCalled();
    expect(options.persistPause).not.toHaveBeenCalled();
    expect(options.engine.shutdown).not.toHaveBeenCalled();
    expect(options.quit).not.toHaveBeenCalled();
  });

  it("Close when finished blocks starts, drains, and cannot be cancelled by another close", async () => {
    choice = "close-when-finished";
    const coordinator = createShutdownCoordinator(options);
    close(coordinator);
    await vi.waitFor(() => expect(options.engine.waitForIdle).toHaveBeenCalledOnce());

    expect(options.engine.beginClose).toHaveBeenCalledWith();
    expect(options.persistPause).not.toHaveBeenCalled();
    expect(coordinator.state()).toBe("draining");

    close(coordinator);
    expect(options.showActiveRunsDialog).toHaveBeenCalledOnce();
    expect(coordinator.state()).toBe("draining");

    idle.resolve();
    await vi.waitFor(() => expect(options.quit).toHaveBeenCalledOnce());
    expect(options.engine.shutdown).toHaveBeenCalledOnce();
  });

  it("Stop agents and close persists pause, cancels, and waits for shutdown cleanup", async () => {
    choice = "cancel-and-close";
    const cleanup = deferred();
    vi.mocked(options.engine.shutdown).mockReturnValue(cleanup.promise);
    const coordinator = createShutdownCoordinator(options);
    close(coordinator);

    await vi.waitFor(() => expect(options.engine.shutdown).toHaveBeenCalledOnce());
    expect(options.persistPause).toHaveBeenCalledOnce();
    expect(options.engine.beginClose).toHaveBeenCalledWith({ cancelRunning: true });
    expect(options.quit).not.toHaveBeenCalled();

    cleanup.resolve();
    await vi.waitFor(() => expect(options.quit).toHaveBeenCalledOnce());
  });

  it.each([
    [false, false],
    [true, true],
  ])("graceful close preserves the persistent pause preference (%s)", async (pauseWasPersistent, expectedAfterRestart) => {
    let persisted = pauseWasPersistent;
    choice = "close-when-finished";
    options.persistPause = vi.fn(() => {
      persisted = true;
    });
    const coordinator = createShutdownCoordinator(options);
    close(coordinator);
    idle.resolve();
    await vi.waitFor(() => expect(options.quit).toHaveBeenCalledOnce());

    expect(persisted).toBe(expectedAfterRestart);
    expect(options.persistPause).not.toHaveBeenCalled();
  });
});
