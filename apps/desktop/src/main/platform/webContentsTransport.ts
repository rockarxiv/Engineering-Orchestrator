import type { BrowserWindow } from "electron";
import type { PushTransport } from "../ipc/push.js";

/**
 * The one `PushTransport` the desktop app has: a window's renderer,
 * reached through `webContents.send` on the wire channel the preload
 * listens for.
 *
 * Under `platform/` since EO-318, with the rest of what is true only of
 * a desktop: it is the Electron half of push delivery, and `push.ts`
 * keeps the half that is not. The import is type-only, so this file is
 * still loadable under plain Node and a test can hand it a fake window
 * — but a type is a dependency too, and the confinement test counts it.
 *
 * The destroyed check is here
 * rather than in `bridgePushChannels` because it is a fact about
 * windows: a window that is closing still has a listener registered
 * until its `closed` handler disposes it, and sending to a destroyed
 * `webContents` throws.
 */
export function webContentsTransport(window: BrowserWindow): PushTransport {
  return {
    send(wireChannel, payload) {
      if (!window.isDestroyed()) {
        window.webContents.send(wireChannel, payload);
      }
    },
  };
}
