import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { bridgePushChannels, emitPush } from "../ipc/push.js";
import { webContentsTransport } from "./webContentsTransport.js";

function createFakeWindow() {
  const send = vi.fn();
  let destroyed = false;
  const fakeWindow = {
    isDestroyed: () => destroyed,
    webContents: { send },
    destroy: () => {
      destroyed = true;
    },
  };
  return { fakeWindow: fakeWindow as unknown as BrowserWindow, send, destroy: fakeWindow.destroy };
}

/**
 * The one transport the desktop app has (KAN-127).
 *
 * `push.test.ts` proves the fan-out; this proves the delivery, and in
 * particular the one rule that is a fact about windows rather than about
 * pushes: a window that has been destroyed is not sent to. Sending to a
 * destroyed `webContents` throws, and a window is destroyed for the
 * moment between its closure and the disposer its `closed` handler runs.
 */
describe("the webContents transport", () => {
  it("sends on the wire channel it is given", () => {
    const { fakeWindow, send } = createFakeWindow();
    const dispose = bridgePushChannels(webContentsTransport(fakeWindow));

    emitPush("runs:changed", { runId: "run-1", itemId: "item-1", status: "running" });

    expect(send).toHaveBeenCalledWith("push:runs:changed", { runId: "run-1", itemId: "item-1", status: "running" });
    dispose();
  });

  it("does not send to a destroyed window", () => {
    const { fakeWindow, send, destroy } = createFakeWindow();
    const dispose = bridgePushChannels(webContentsTransport(fakeWindow));
    destroy();

    emitPush("runs:changed", { runId: "run-1", itemId: "item-1", status: "running" });

    expect(send).not.toHaveBeenCalled();
    dispose();
  });
});
