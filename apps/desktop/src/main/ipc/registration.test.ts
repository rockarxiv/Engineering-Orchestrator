import { ipcContract, type IpcChannel } from "@eo/core";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOLS } from "../mcpHost/catalog.js";
import { clearHandlerRegistry, dispatchIpc, registeredChannels } from "./registry.js";

/**
 * That registering a handler makes it reachable, and that there is only
 * one way to reach it.
 *
 * `registerHandler` used to do two things: hand the handler to
 * `ipcMain`, which was how the renderer reached it, and record it in
 * `registry.ts`, which is how the MCP host does. Nothing tested the
 * second half. Deleting that one line left all 1546 tests in this
 * project green and every MCP tool in production answering "EO has no
 * handler registered for …" — a failure that would first be seen by
 * whoever connected an editor to a shipped build.
 *
 * Since EO-318 there is only the record, and the renderer's door is hung
 * from it: `platform.serveIpc()` walks `registeredChannels()` once and
 * points each `ipcMain.handle` at this module's `dispatchIpc`. So the
 * half that had no test is now the only half there is, and the two
 * assertions below are what used to be three: registering it records it,
 * and what is recorded is what every door will dispatch.
 *
 * No `electron` mock any more — nothing in this graph imports it, which
 * is the property `electronConfinement.test.ts` states outright.
 */
afterEach(() => {
  clearHandlerRegistry();
  vi.resetModules();
});

describe("registering a handler", () => {
  it("makes it reachable without ipcMain", async () => {
    const { registerHandler } = await import("./registry.js");

    registerHandler("app:getVersion", () => ({ version: "9.9.9" }), { exposeErrorDetails: true });

    await expect(dispatchIpc("app:getVersion", undefined)).resolves.toEqual({ ok: true, data: { version: "9.9.9" } });
    // What `serveIpc` walks: a channel missing from here is a channel
    // the renderer's door is never hung on.
    expect(registeredChannels()).toEqual(["app:getVersion"]);
  });
});

/**
 * A tool naming a channel nobody answers.
 *
 * `catalog.test.ts` proves every catalogued channel exists in the
 * *contract*; this proves one exists in the *app*. They are different
 * failures: the first is a typo caught at build time, the second is a
 * tool that lists cleanly, advertises a schema, and then returns "EO has
 * no handler registered for …" the first time anyone calls it.
 *
 * Read as source text for the same reason reachable.test.ts does: what
 * matters is whether a registration exists anywhere in main, including
 * in the files handlers.ts does not own, rather than whether one
 * particular module graph happens to link.
 *
 * It used to be read as text for a second reason as well —
 * `registerAllHandlers` reached for `app`, `safeStorage` and
 * `BrowserWindow`, none of which exist under vitest. That reason is
 * gone: since KAN-127 the handlers take a `Platform`, and
 * handlers.test.ts calls the real thing with a fake one and checks every
 * channel is answerable. This scan is the wider net, not the only one.
 */
function sourceUnder(root: string): string {
  let text = "";
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      text += sourceUnder(path);
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    text += readFileSync(path, "utf8");
  }
  return text;
}

describe("every channel the MCP catalog names", () => {
  it("has a handler registered for it", () => {
    const main = sourceUnder(join(dirname(fileURLToPath(import.meta.url)), ".."));
    const registered = new Set([...main.matchAll(/registerHandler\(\s*"([^"]+)"/g)].map((match) => match[1]));

    const unanswered = [...new Set(TOOLS.flatMap((tool) => tool.channels))].filter((channel) => !registered.has(channel));

    expect(unanswered).toEqual([]);
  });

  it("is a channel the contract actually declares", () => {
    // Belt to catalog.test.ts's braces, and free: a tool naming a
    // channel that no longer exists would otherwise be caught only by
    // the check above, whose failure message points at handlers.ts.
    const invented = [...new Set(TOOLS.flatMap((tool) => tool.channels))].filter((channel) => !(channel in ipcContract));

    expect(invented as IpcChannel[]).toEqual([]);
  });
});
