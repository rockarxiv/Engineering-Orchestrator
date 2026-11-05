import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { listItemSummaries } from "../ipc/domainQueries.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import type { SecretStore } from "../secrets/store.js";
import { writeMcpConfig } from "./gate.js";
import { createMcpHost, type McpHostHandle } from "./index.js";

/**
 * The server as the app starts and stops it.
 *
 * The point of these is the promise made in this module's header: the
 * MCP server is an accessory and never a dependency. Every way it can
 * fail has to end in a status a screen can show, not in something that
 * reaches app startup.
 */
function fakeStore(available = true): SecretStore {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => Buffer.from(`enc:${plainText}`, "utf8"),
    decryptString: (encrypted) => {
      // A machine with no keychain cannot read one either. Letting the
      // fake decrypt regardless would make it possible to pass a test
      // that real safeStorage would fail.
      if (!available) throw new Error("no keychain");
      return encrypted.toString("utf8").slice(4);
    },
  };
}

const store = fakeStore();

let handle: DbHandle;
let directory: string;
let host: McpHostHandle;
let squatter: Server | null = null;

/** A free port, released again — what "already in use" needs to be about a real number. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo-mcp-host-"));
  registerHandler("items:list", () => listItemSummaries(handle.db, null), { exposeErrorDetails: true });
  host = createMcpHost({ db: handle.db, version: "0.0.0-test", tokens: { directory, store } });
});

afterEach(async () => {
  await host.stop();
  await new Promise<void>((resolve) => (squatter ? squatter.close(() => resolve()) : resolve()));
  squatter = null;
  clearHandlerRegistry();
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the MCP host's lifecycle", () => {
  it("listens nothing on a database that has never been asked", async () => {
    const status = await host.reconcile();

    expect(status).toMatchObject({ enabled: false, listeningPort: null, problem: null });
  });

  it("mints a token and binds only once it is turned on", async () => {
    writeMcpConfig(handle.db, { enabled: true, port: 0 });

    const status = await host.reconcile();

    expect(status.listeningPort).toBeGreaterThan(0);
    expect(status.problem).toBeNull();
    // The value itself is not this module's to hand out — mcpCommands
    // reads it for the settings screen, which is the only caller that
    // needs it. Here, only that one exists.
    expect(status.tokenConfigured).toBe(true);
  });

  it("stops listening when it is turned off", async () => {
    writeMcpConfig(handle.db, { enabled: true, port: 0 });
    await host.reconcile();

    writeMcpConfig(handle.db, { enabled: false });
    const status = await host.reconcile();

    expect(status.listeningPort).toBeNull();
  });

  it("reports a busy port instead of failing to start", async () => {
    // The case the original design named as a real cost of running a server
    // beside the app: "a backend failed to start error state users will
    // hit". This is the answer — a sentence in Settings, and an app that
    // is otherwise exactly as it was.
    const port = await freePort();
    squatter = createServer();
    await new Promise<void>((resolve) => squatter!.listen({ host: "127.0.0.1", port }, resolve));

    writeMcpConfig(handle.db, { enabled: true, port });
    const status = await host.reconcile();

    expect(status.listeningPort).toBeNull();
    expect(status.problem).toContain("already in use");
    // And it names where to fix it, rather than only what went wrong.
    expect(status.problem).toContain("Settings");
  });

  it("recovers once the port is free, without a restart", async () => {
    const port = await freePort();
    squatter = createServer();
    await new Promise<void>((resolve) => squatter!.listen({ host: "127.0.0.1", port }, resolve));

    writeMcpConfig(handle.db, { enabled: true, port });
    expect((await host.reconcile()).problem).not.toBeNull();

    await new Promise<void>((resolve) => squatter!.close(() => resolve()));
    squatter = null;

    const status = await host.reconcile();
    expect(status.listeningPort).toBe(port);
    expect(status.problem).toBeNull();
  });

  it("says how many tools the gate is currently offering", async () => {
    // What lets Settings tell someone what the destructive switch costs
    // before they flip it, rather than after.
    const closed = await host.reconcile();
    writeMcpConfig(handle.db, { dangerousOperations: true });
    const open = await host.reconcile();

    // Strictly greater, and the closed count non-zero. The original
    // `toBeGreaterThanOrEqual` passed with the field hardcoded to 0 —
    // which is exactly the bug it existed to catch, since the number is
    // what Settings shows someone deciding whether to open the gate.
    expect(closed.toolCount).toBeGreaterThan(0);
    expect(open.toolCount).toBeGreaterThan(closed.toolCount);
  });

  it("refuses a keychain that is unlocked storage in disguise", async () => {
    // Electron's `basic_text` backend reports itself available and
    // encrypts with a password compiled into Chromium, so the ciphertext
    // is readable by anything running as this user — which is exactly
    // the set of processes the token exists to exclude.
    const exposed = createMcpHost({
      db: handle.db,
      version: "0.0.0-test",
      tokens: {
        directory: mkdtempSync(join(tmpdir(), "eo-mcp-basictext-")),
        store: { ...fakeStore(), getSelectedStorageBackend: () => "basic_text" },
      },
    });
    writeMcpConfig(handle.db, { enabled: true, port: 0 });

    const status = await exposed.reconcile();

    expect(status.listeningPort).toBeNull();
    expect(status.problem).toContain("basic_text");
    await exposed.stop();
  });

  it("refuses to run without somewhere safe to keep its token", async () => {
    // A Linux box with no keyring at all. A bearer token written in the
    // clear would be worse than no server.
    // Its own directory: sharing one with a host that has already minted
    // a token would test "can it reuse a token", not "can it make one".
    const keylessDirectory = mkdtempSync(join(tmpdir(), "eo-mcp-keyless-"));
    const keyless = createMcpHost({
      db: handle.db,
      version: "0.0.0-test",
      tokens: { directory: keylessDirectory, store: fakeStore(false) },
    });
    writeMcpConfig(handle.db, { enabled: true, port: 0 });

    const status = await keyless.reconcile();

    expect(status.listeningPort).toBeNull();
    expect(status.problem).toContain("keychain");
    await keyless.stop();
    rmSync(keylessDirectory, { recursive: true, force: true });
  });
});
