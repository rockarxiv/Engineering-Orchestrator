import { afterEach, describe, expect, it, vi } from "vitest";
import { clearHandlerRegistry, dispatchIpc, registerHandler, registeredChannels } from "./registry.js";

/**
 * The seam the MCP host stands on.
 *
 * These run under plain Node with no Electron anywhere in the import
 * graph, which is the property registry.ts exists to have: a test that
 * needed `ipcMain` would prove the opposite of what this file is for.
 */
const opts = { exposeErrorDetails: true };

afterEach(() => {
  clearHandlerRegistry();
});

describe("the handler registry", () => {
  it("dispatches through the same validation and envelope ipcMain would", async () => {
    registerHandler("app:getVersion", () => ({ version: "1.2.3" }), opts);

    await expect(dispatchIpc("app:getVersion", undefined)).resolves.toEqual({
      ok: true,
      data: { version: "1.2.3" },
    });
  });

  it("rejects a payload its channel's schema refuses, without reaching the handler", async () => {
    const handler = vi.fn(() => ({ itemId: "t1", costCents: 0, sideCalls: [] }));
    registerHandler("costs:getForItem", handler, opts);

    const result = await dispatchIpc("costs:getForItem", { itemId: 7 });

    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers for an unregistered channel rather than throwing", async () => {
    // What a dispatch before registerAllHandlers looks like. It has to be
    // an envelope: the host turns one of these into a tool error, and a
    // throw here would take the whole request down instead.
    const result = await dispatchIpc("items:list", undefined);

    expect(result).toEqual({ ok: false, error: { message: 'EO has no handler registered for "items:list".' } });
  });

  it("refuses a second handler for the same channel", () => {
    registerHandler("app:getVersion", () => ({ version: "1" }), opts);

    // ipcMain.handle throws on this too, but only inside a running
    // Electron process — where nobody is watching for it.
    expect(() => registerHandler("app:getVersion", () => ({ version: "2" }), opts)).toThrow(/already registered/);
  });

  it("reports what it can answer", () => {
    registerHandler("app:getVersion", () => ({ version: "1" }), opts);
    registerHandler("engine:status", () => ({ paused: false, activeRunCount: 0, finishingRunCount: 0 }), opts);

    expect(registeredChannels().sort()).toEqual(["app:getVersion", "engine:status"]);
  });
});
