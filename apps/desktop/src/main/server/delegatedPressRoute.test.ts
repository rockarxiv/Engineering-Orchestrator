import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearHandlerRegistry } from "../ipc/registry.js";
import { sourceTreeResources } from "../testing/platform.js";
import { removeScratch } from "../testing/scratch.js";
import type { ServerConfig } from "./config.js";
import { startServer, type RunningServer } from "./start.js";

/**
 * Who may tell the record that a press was made *for* its person
 * (EO-918, `ARCHITECTURE.md`, "Messages").
 *
 * A real server on a real socket, because the claim is about the door:
 * `record:handleMessageFor` carries `by` — the assistant, or an outside
 * MCP client — and the door can vouch for the device asking but not for
 * that word. So it takes it only from a desktop's token (a device that
 * signed in running work, which the served renderer never does) and never
 * from a request a browser made, while a browser's own press on
 * `record:handleMessage` reaches the record as it always has.
 *
 * The mocks are `smoke.test.ts`'s, for its reason.
 */
vi.mock("electron", () => {
  throw new Error("The server loaded Electron. A headless host has none.");
});
vi.mock("electron-updater", () => {
  throw new Error("The server loaded electron-updater. A server is updated by whatever installed it.");
});

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const TOKEN = "an-admin-token-from-the-environment";
const PASSWORD = "a-long-enough-password";
const BROWSER_HEADERS = { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin" };

let running: { server: RunningServer; directory: string } | null = null;

afterEach(async () => {
  clearHandlerRegistry();
  if (running === null) return;
  const { server, directory } = running;
  running = null;
  await server.main.stop();
  await server.platform.stopServing();
  server.release();
  removeScratch(directory);
});

async function start(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "eo-delegated-press-"));
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    secretKey: Buffer.alloc(32, 7),
    userDataPath: join(directory, "data"),
    rendererDirectory: null,
    version: "7.7.7",
  };
  const started = startServer(config, { resources: sourceTreeResources(), exit: () => {} });
  if (!started.ok) throw new Error(started.problem);
  running = { server: started.server, directory };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const address = started.server.platform.address();
    if (address !== null) return `http://${address.host}:${address.port}`;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The server never bound a port.");
}

async function call(base: string, channel: string, payload: unknown, bearer: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(`${base}/ipc/${encodeURIComponent(channel)}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, ...headers },
    body: JSON.stringify({ payload }),
  });
  return response.json();
}

/** Anna signed in as a desktop (running work) or from the renderer the server serves. */
async function signedIn(base: string, asADesktop: boolean): Promise<string> {
  const email = `anna+${asADesktop ? "desk" : "browser"}@example.com`;
  const invited = (await call(base, "people:invite", { email, name: "Anna" }, TOKEN)) as { data: { invitePath: string } };
  await call(base, "auth:acceptInvitation", { code: invited.data.invitePath.slice("/invite/".length), kind: "password", password: PASSWORD }, TOKEN);
  const response = await fetch(`${base}/ipc/auth%3AsignIn`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(asADesktop ? {} : BROWSER_HEADERS) },
    body: JSON.stringify({
      payload: { email, password: PASSWORD, deviceName: asADesktop ? "annas-macbook" : "annas-browser", ...(asADesktop ? { runsWork: true } : {}) },
    }),
  });
  const body = (await response.json()) as { data: { session: { token: string } | null; problem: string | null } };
  if (body.data.session === null) throw new Error(`the sign-in was refused: ${body.data.problem ?? "no reason given"}`);
  return body.data.session.token;
}

const press = { deviceId: "whatever-the-client-says", messageId: "0190f5f0-0000-7000-8000-000000000001", how: "dismissed", answer: null };
const delegated = { ...press, by: { kind: "assistant", agentId: "0190f5f0-0000-7000-8000-0000000000aa" } };

/** What the door says when it refuses `record:handleMessageFor` before the record sees it. */
const REFUSED = { ok: false, error: { message: expect.stringContaining('"record:handleMessageFor" is something only a desktop') } };
/** What the record itself answers for a message it does not hold: the press reached it. */
const REACHED = { ok: true, data: { message: null, problem: expect.any(String) } };

describe("a press made for the person, at the record's door", () => {
  it("is refused from the served renderer's token, which never ran work", async () => {
    const base = await start();
    const browser = await signedIn(base, false);

    expect(await call(base, "record:handleMessageFor", delegated, browser, BROWSER_HEADERS)).toEqual(REFUSED);
    // Copied out of `sessionStorage` and sent without a browser's headers,
    // it is still the renderer's token, and still refused.
    expect(await call(base, "record:handleMessageFor", delegated, browser)).toEqual(REFUSED);
  });

  it("is refused from a browser even when it carries a desktop's token", async () => {
    const base = await start();
    const desktop = await signedIn(base, true);

    expect(await call(base, "record:handleMessageFor", delegated, desktop, BROWSER_HEADERS)).toEqual(REFUSED);
  });

  it("reaches the record from a desktop", async () => {
    const base = await start();
    const desktop = await signedIn(base, true);

    expect(await call(base, "record:handleMessageFor", delegated, desktop)).toEqual(REACHED);
  });

  it("leaves a browser's own press on the person's channel as it was", async () => {
    const base = await start();
    const browser = await signedIn(base, false);

    expect(await call(base, "record:handleMessage", press, browser, BROWSER_HEADERS)).toEqual(REACHED);
  });

  it("is refused to the operator's key, which is no device at all", async () => {
    const base = await start();

    expect(await call(base, "record:handleMessageFor", delegated, TOKEN)).toMatchObject({ ok: false });
  });
});
