import type { IpcResponse, UpdateStatus } from "@eo/core";
import type { UpdateController } from "../updater.js";

/**
 * What the `updates:*` channels are answered from (EO-201).
 *
 * The controller is reached through a getter rather than held, because
 * on a packaged build it does not exist yet when handlers are
 * registered: electron-updater is loaded through a dynamic import, and
 * waiting for it before registering would hold up every other channel
 * behind a network-free but still asynchronous module load.
 */
export interface UpdateContext {
  controller: () => UpdateController | undefined;
  /**
   * `createShutdownCoordinator`'s `requestClose`.
   *
   * The only way this file can cause a restart. `quitAndInstall` is
   * deliberately unreachable from here — the coordinator owns every path
   * out of the process, so a person pressing *Update and restart* with
   * agents running gets the same dialog a window close gives them,
   * answered the same way, rather than a second question written here.
   */
  requestClose: () => void;
}

/**
 * The answer for a build whose controller never got made — a test
 * registering handlers without one, or a load that failed before it
 * could report a reason of its own. Says there is nothing to do rather
 * than offering a button that cannot work.
 */
const NO_CONTROLLER: UpdateStatus = { state: "unsupported" };

export function updateStatus(context: UpdateContext): IpcResponse<"updates:status"> {
  return context.controller()?.status() ?? NO_CONTROLLER;
}

export async function checkForUpdates(context: UpdateContext): Promise<IpcResponse<"updates:check">> {
  const controller = context.controller();
  return controller ? await controller.check() : NO_CONTROLLER;
}

export async function downloadUpdate(context: UpdateContext): Promise<IpcResponse<"updates:download">> {
  const controller = context.controller();
  return controller ? await controller.download() : NO_CONTROLLER;
}

/**
 * Ask to restart into the staged update.
 *
 * Refuses when nothing is staged, which is what keeps a failed download
 * from being able to restart the app: `download` leaves the controller
 * in `error`, `isStaged()` is false, and this returns without ever
 * reaching the coordinator.
 *
 * `requested: true` means the coordinator has been asked, not that the
 * app is going. It may raise the active-agents dialog and be told to
 * keep EO open — in which case the update stays staged, and the section
 * still offers the restart.
 */
export function installUpdate(context: UpdateContext): IpcResponse<"updates:install"> {
  if (!context.controller()?.isStaged()) return { requested: false };
  context.requestClose();
  return { requested: true };
}

/**
 * The shutdown coordinator's `quit` callback: leave, or leave into a
 * staged update.
 *
 * Exported rather than written inline in index.ts so that the wiring and
 * the test which proves it are the same code. A test asserting against
 * its own copy of a one-line callback proves that the copy works, which
 * is exactly the failure mode worth avoiding in the one path that
 * decides whether the binary is replaced.
 *
 * `quitAndInstall` closes every window and quits by itself, so it
 * replaces the plain quit rather than preceding it.
 */
export function quitOrInstall(controller: () => UpdateController | undefined, quit: () => void): () => void {
  return () => {
    const staged = controller();
    if (staged?.isStaged()) staged.installStaged();
    else quit();
  };
}
