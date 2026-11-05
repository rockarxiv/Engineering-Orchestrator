/**
 * What the composition root takes from `ipc/` (EO-318).
 *
 * Trimmed to that, because that is now all it is: the barrel used to
 * carry the window's push bridge and the tick producer as well, for an
 * index.ts that opened the window itself. Those moved to
 * `platform/electron.ts`, which imports the modules it needs directly
 * rather than through here — a barrel that pulls in handlers.ts is a
 * heavier edge than the platform has any reason to have.
 */
export { registerAllHandlers } from "./handlers.js";
export { emitPush } from "./push.js";
export type { Platform } from "./platform.js";
export { clearHandlerRegistry, dispatchIpc, registerHandler, registeredChannels } from "./registry.js";
