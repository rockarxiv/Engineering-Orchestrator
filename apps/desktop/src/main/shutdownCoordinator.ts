export type ShutdownChoice = "keep-open" | "close-when-finished" | "cancel-and-close";

export interface ShutdownEngine {
  activeRunCount: () => number;
  /** Stops every new run of every agent, the system agent's included; `cancelRunning` stops them all as well. */
  beginClose: (opts?: { cancelRunning?: boolean }) => void;
  waitForIdle: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export interface ShutdownCoordinatorOptions {
  engine: ShutdownEngine;
  showActiveRunsDialog: () => Promise<ShutdownChoice>;
  persistPause: () => void;
  stopBackgroundServices: () => void;
  quit: () => void;
  /**
   * Told when a close that was asked for ends with EO still open — the
   * person chose *Keep EO open*, or the dialog could not be shown
   * (EO-696). Whatever was riding on that close, such as a restart into
   * a downloaded update, is withdrawn here, so a later ordinary quit is
   * only a quit.
   */
  onStayOpen?: () => void;
}

type CloseEvent = { preventDefault: () => void };
type ShutdownState = "open" | "choosing" | "draining" | "finalizing" | "ready-to-quit";

/**
 * Owns every path out of the Electron process.
 *
 * Electron can ask to quit through a BrowserWindow close, the application
 * menu, an OS session request, or window-all-closed. Keeping the state here
 * makes those requests idempotent: in particular, a second close cannot turn
 * a graceful drain into a cancellation.
 */
export function createShutdownCoordinator(options: ShutdownCoordinatorOptions) {
  let state: ShutdownState = "open";

  async function finalize(): Promise<void> {
    if (state === "finalizing" || state === "ready-to-quit") return;
    state = "finalizing";
    options.stopBackgroundServices();
    try {
      await options.engine.shutdown();
    } finally {
      state = "ready-to-quit";
      options.quit();
    }
  }

  async function choose(): Promise<void> {
    let choice: ShutdownChoice;
    try {
      choice = await options.showActiveRunsDialog();
    } catch (error) {
      // A failed native dialog must leave the app open, not silently turn a
      // warning failure into destructive shutdown.
      console.error("[eo] failed to show active-agent close warning:", error);
      state = "open";
      options.onStayOpen?.();
      return;
    }

    if (choice === "keep-open") {
      state = "open";
      options.onStayOpen?.();
      return;
    }

    if (choice === "close-when-finished") {
      // Runtime-only: the persistent preference is deliberately untouched.
      // beginClose() closes both automatic and manual provider-boundary races.
      state = "draining";
      options.engine.beginClose();
      await options.engine.waitForIdle();
      await finalize();
      return;
    }

    // Forced close has different restart semantics, so persist first. If the
    // process is killed during cleanup it will still reopen safely paused.
    options.persistPause();
    options.engine.beginClose({ cancelRunning: true });
    await finalize();
  }

  /**
   * The one way out of the process, whatever asked.
   *
   * `event` is optional because not every request comes from Electron.
   * EO-201's *Update and restart* calls this with nothing to prevent —
   * it is not a window close, it is a person asking to exit into a
   * staged update — and everything after this line is identical for
   * both. That is the whole reason the button routes through here: the
   * active-agents dialog, the drain and the persisted pause are asked
   * once, in one place, rather than reimplemented beside the updater.
   *
   * Answers whether this request is the one that started a close: false
   * when one was already under way, which this call has only joined
   * (EO-696). A restart into an update needs to know, because it may
   * install only when it is what led to the quit.
   */
  function requestClose(event?: CloseEvent): boolean {
    if (state === "ready-to-quit") return false;
    event?.preventDefault();

    if (state !== "open") return false;
    if (options.engine.activeRunCount() === 0) {
      // Close the provider-boundary race for preflight work that is not
      // counted as an active agent yet. This remains runtime-only.
      options.engine.beginClose();
      void finalize();
      return true;
    }

    state = "choosing";
    void choose();
    return true;
  }

  return {
    requestClose,
    state: () => state,
  };
}
