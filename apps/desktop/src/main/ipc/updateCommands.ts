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
   * `createShutdownCoordinator`'s `requestClose`, answering whether
   * this call is what started the close.
   *
   * The only way this file can cause a restart. `quitAndInstall` is
   * deliberately unreachable from here — the coordinator owns every path
   * out of the process, so a person pressing *Restart and update* with
   * agents running gets the same dialog a window close gives them,
   * answered the same way, rather than a second question written here.
   */
  requestClose: () => boolean;
  /**
   * Whether the person has asked to restart into the update (EO-696).
   * Shared with `quitOrInstall`, which installs only while it is set.
   */
  installRequest: InstallRequest;
}

/**
 * The one bit that tells a restart for an update from an ordinary quit
 * (EO-696).
 *
 * Set by `updates:install` just before it asks the coordinator to close,
 * and withdrawn when that close does not happen: the coordinator was
 * already closing for some other reason, or the person answered the
 * active-agents dialog with *Keep EO open* (the coordinator's
 * `onStayOpen`). While it is clear, a downloaded update stays on disk
 * through any quit — a window close, Cmd/Ctrl+Q, the OS — and is
 * offered again next time.
 */
export interface InstallRequest {
  request: () => void;
  withdraw: () => void;
  isRequested: () => boolean;
}

export function createInstallRequest(): InstallRequest {
  let requested = false;
  return {
    request: () => {
      requested = true;
    },
    withdraw: () => {
      requested = false;
    },
    isRequested: () => requested,
  };
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
 * keep EO open — in which case the request is withdrawn, the update
 * stays staged, and the section still offers the restart.
 *
 * The request is marked before the coordinator is asked, because a close
 * with no agents running reaches `quit` without anybody being asked
 * anything. A press while a close is already under way for another
 * reason is not what leads to that quit, so it is withdrawn and refused.
 */
export function installUpdate(context: UpdateContext): IpcResponse<"updates:install"> {
  if (!context.controller()?.isStaged()) return { requested: false };
  context.installRequest.request();
  if (context.requestClose()) return { requested: true };
  context.installRequest.withdraw();
  return { requested: false };
}

/**
 * The shutdown coordinator's `quit` callback: leave, or — only when the
 * person pressed *Restart and update* and that is what led here — leave
 * into the staged update (EO-696). Every other quit leaves the download
 * on disk and quits plainly.
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
export function quitOrInstall(controller: () => UpdateController | undefined, installRequest: InstallRequest, quit: () => void): () => void {
  return () => {
    const staged = controller();
    if (installRequest.isRequested() && staged?.isStaged()) staged.installStaged();
    else quit();
  };
}
