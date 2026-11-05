import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import type { SecretStore } from "../secrets/store.js";
import { DEFAULT_PORT, readMcpConfig } from "../mcpHost/gate.js";
import { createMcpHost, type McpHostHandle } from "../mcpHost/index.js";
import { getMcpStatus, regenerateMcpToken, setMcpConfig, type McpContext } from "./mcpCommands.js";

/**
 * The settings screen's side of the MCP server.
 *
 * Untested until a review pointed out that the three things it does —
 * resolving `port: 0` to a real one, handing back the token in full, and
 * restarting so a regenerated token actually drops open sessions — were
 * each load-bearing and each unasserted.
 */
const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(`enc:${plainText}`, "utf8"),
  decryptString: (encrypted) => encrypted.toString("utf8").slice(4),
};

let handle: DbHandle;
let directory: string;
let host: McpHostHandle;
let context: McpContext;

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo-mcp-commands-"));
  const tokens = { directory, store };
  host = createMcpHost({ db: handle.db, version: "0.0.0-test", tokens });
  context = { host, tokens };
});

afterEach(async () => {
  await host.stop();
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("reading the status", () => {
  it("starts off, on the default port, with no token yet", () => {
    expect(getMcpStatus(context)).toMatchObject({
      enabled: false,
      dangerousOperations: false,
      port: DEFAULT_PORT,
      listeningPort: null,
      token: null,
    });
  });

  it("hands back the token in full once there is one", async () => {
    // The one secret in this contract that travels, and deliberately:
    // it is typed into another program's config file, so a screen that
    // cannot show it is a server nobody can connect to.
    await setMcpConfig(handle.db, context, { enabled: true, port: 0 });

    expect(getMcpStatus(context).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("changing the configuration", () => {
  it("resolves a request for a free port into a real, stored number", async () => {
    // `0` is the screen asking EO to find one, because the server will
    // not wander on its own. It has to be resolved here and *stored*, or
    // the snippets would name a port nothing is on.
    const status = await setMcpConfig(handle.db, context, { enabled: true, port: 0 });

    expect(status.port).toBeGreaterThanOrEqual(1024);
    expect(status.port).toBe(status.listeningPort);
    expect(readMcpConfig(handle.db).port).toBe(status.port);
  });

  it("describes a server that has finished moving, not one about to", async () => {
    // Two reconciles start on every write — the config listener's and
    // this one. The status returned has to be the settled one.
    const status = await setMcpConfig(handle.db, context, { enabled: true, port: 0 });

    expect(status.listeningPort).not.toBeNull();
    expect(status.problem).toBeNull();
  });

  it("writes only the key it was given", async () => {
    await setMcpConfig(handle.db, context, { enabled: true, port: 0 });
    const before = readMcpConfig(handle.db).port;

    await setMcpConfig(handle.db, context, { dangerousOperations: true });

    expect(readMcpConfig(handle.db)).toMatchObject({ enabled: true, port: before, dangerousOperations: true });
  });

  it("says so rather than throwing when it cannot find a port to offer", async () => {
    // This module promises every failure comes back as a `problem`
    // string. An un-caught rejection here would surface to the renderer
    // as "Internal error", which tells nobody anything.
    const freePort = await import("../mcpHost/http.js");
    vi.spyOn(freePort, "freePort").mockRejectedValueOnce(new Error("no sockets"));

    const status = await setMcpConfig(handle.db, context, { enabled: true, port: 0 });

    expect(status.problem).toContain("free port");
    vi.restoreAllMocks();
  });
});

describe("regenerating the token", () => {
  it("mints a different one and leaves the server listening on it", async () => {
    await setMcpConfig(handle.db, context, { enabled: true, port: 0 });
    const before = getMcpStatus(context).token;

    const after = await regenerateMcpToken(context);

    expect(after.token).not.toBe(before);
    expect(after.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Restarted rather than left down: the point is to drop sessions
    // holding the old credential, not to turn the server off.
    expect(after.listeningPort).not.toBeNull();
  });

  it("keeps watching the configuration afterwards", async () => {
    // `restart` goes through the same queue as everything else. An
    // earlier version called `stop()`, which also disposed the config
    // subscription — so the server would never notice another change.
    await setMcpConfig(handle.db, context, { enabled: true, port: 0 });
    await regenerateMcpToken(context);

    const status = await setMcpConfig(handle.db, context, { enabled: false });

    expect(status.listeningPort).toBeNull();
  });
});
