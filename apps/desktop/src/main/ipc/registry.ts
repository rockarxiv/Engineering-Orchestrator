import type { IpcChannel, IpcResult } from "@eo/core";
import { handleIpcRequest, type HandleIpcRequestOptions, type IpcHandlerFn } from "./handleRequest.js";

/**
 * Every registered handler, by channel, callable without Electron.
 *
 * The renderer reaches a handler through `ipcMain.handle`; the MCP host
 * has no `ipcMain` and must reach the *same* one. Not a second copy of
 * it: the handlers registered in handlers.ts close over context that
 * file builds and does not export — the AttachmentStorage, the Jira
 * credentials directory, the module-secrets store, the engine handle —
 * and they emit the pushes that keep every open window honest
 * (`emitPush("items:changed")` after a delete lives inside the
 * closure, not beside it). A parallel path assembled from the command
 * functions would be a second door that starts identical and drifts.
 *
 * So registering a handler *is* recording it here, and every door
 * dispatches through `handleIpcRequest` — same request validation, same
 * response validation, same envelope, and the same `exposeErrorDetails`
 * the renderer gets, so no door can accidentally become the chattier of
 * them.
 *
 * Since EO-318 that is true of `ipcMain` as well, which used to be
 * attached here per channel by a registerHandler.ts that imported
 * Electron for it. The platform now attaches one `ipcMain.handle` per
 * `registeredChannels()` entry, calling this module's `dispatchIpc` —
 * so the renderer's door and the MCP host's are the same door, and this
 * file is the only definition of "registered" there is.
 *
 * Deliberately *not* a table that handlers.ts loops over. reachable.test.ts
 * reads that file as text to prove all of the contract's channels have a
 * handler, and a loop hides every one of them from it — the same trade
 * already written down above `projects:create` there.
 *
 * This module must never import `electron`. Its whole point is that the
 * host and its tests can dispatch under plain Node.
 */
interface Registration {
  /** Already bound to its channel's types, which is why nothing here needs a cast. */
  invoke: (rawPayload: unknown) => Promise<IpcResult<unknown>>;
}

const registrations = new Map<IpcChannel, Registration>();

export function registerHandler<K extends IpcChannel>(
  channel: K,
  handler: IpcHandlerFn<K>,
  options: HandleIpcRequestOptions,
): void {
  // `ipcMain.handle` throws on a second registration for the same
  // channel; without this, a duplicate would be caught only in a running
  // Electron process and never in a test.
  if (registrations.has(channel)) throw new Error(`A handler is already registered for "${channel}"`);
  registrations.set(channel, { invoke: (rawPayload) => handleIpcRequest(channel, rawPayload, handler, options) });
}

/**
 * Which channels are answerable right now.
 *
 * Read by `registration.test.ts`, which proves that registering a
 * handler actually makes it reachable — the half of `registerHandler`
 * that had no test, and whose deletion left every MCP tool broken in
 * production with all 1546 tests green. Read by `platform/electron.ts`
 * too, which is now how the renderer's own door is hung.
 */
export function registeredChannels(): IpcChannel[] {
  return [...registrations.keys()];
}

/**
 * Calls a handler the way the renderer would.
 *
 * `unknown` on the way out, and on purpose: the response has just been
 * validated against `ipcContract[channel].response`, so a caller
 * re-narrowing it with that same schema is honest where a cast here
 * would be a promise this function cannot keep for every channel at
 * once.
 */
export async function dispatchIpc(channel: IpcChannel, rawPayload: unknown): Promise<IpcResult<unknown>> {
  const registration = registrations.get(channel);
  if (!registration) {
    // Reachable in exactly one way: something dispatched before
    // registerAllHandlers ran. Said plainly rather than as a crash.
    return { ok: false, error: { message: `EO has no handler registered for "${channel}".` } };
  }
  return registration.invoke(rawPayload);
}

/** Tests only. There is no unregister in production: handlers are registered once, at startup. */
export function clearHandlerRegistry(): void {
  registrations.clear();
}
