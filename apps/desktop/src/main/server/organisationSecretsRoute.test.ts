import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipcContract, ORGANISATION_SECRETS_PATH } from "@eo/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearHandlerRegistry } from "../ipc/registry.js";
import { sourceTreeResources } from "../testing/platform.js";
import type { ServerConfig } from "./config.js";
import { startServer, type RunningServer } from "./start.js";
import { removeScratch } from "../testing/scratch.js";

/**
 * How the values behind an organisation's secrets reach a device
 * (EO-328, `ARCHITECTURE.md`, "Secrets").
 *
 * A real server on a real socket, because the claim this file exists to
 * check is a claim about the *door*: an admin sets a secret over a
 * channel, a device that runs work collects it over a path that is not a
 * channel and against a credential no renderer holds, and there is no
 * third way in.
 *
 * **Two properties, and the second is the one a review caught.** That
 * the route is not under `/ipc/` bought nothing on its own, because the
 * renderer a server hands a browser holds a device token in
 * `sessionStorage` — it needs one to POST a channel — and that same
 * token opened this. So the credential is now a *second* secret, minted
 * only for a client that signed in declaring it runs work, and the
 * cases below walk both sides of that line: a device token is refused,
 * and a browser is issued nothing to refuse with.
 *
 * `policy/ipcLeak.test.ts` is the other end of the same argument: it
 * walks the whole contract and finds the value nowhere.
 *
 * The mocks below are `smoke.test.ts`'s, for its reason: a single
 * `import "electron"` anywhere in the graph this pulls in fails these
 * tests, and a server binary that loaded Electron would not be a server
 * binary.
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
const SECRET_KEY = Buffer.alloc(32, 7);
const VALUE = "fly-token-eo328";

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

function start(): RunningServer {
  const directory = mkdtempSync(join(tmpdir(), "eo-org-secrets-"));
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    secretKey: SECRET_KEY,
    userDataPath: join(directory, "data"),
    rendererDirectory: null,
    version: "7.7.7",
  };
  const started = startServer(config, { resources: sourceTreeResources(), exit: () => {} });
  if (!started.ok) throw new Error(started.problem);
  running = { server: started.server, directory };
  return started.server;
}

async function origin(server: RunningServer): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const address = server.platform.address();
    if (address !== null) return `http://${address.host}:${address.port}`;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The server never bound a port.");
}

function call(base: string, channel: string, payload: unknown, bearer = TOKEN): Promise<Response> {
  return fetch(`${base}/ipc/${channel}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ payload }),
  });
}

/** Collects the organisation's secret values with whatever credential it is given. */
function collect(base: string, bearer: string | null): Promise<Response> {
  return fetch(`${base}${ORGANISATION_SECRETS_PATH}`, {
    ...(bearer === null ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
  });
}

/**
 * A person on the list, and a sign-in as one kind of client or the
 * other.
 *
 * `runsWork` is the whole of the difference: the desktop's main process
 * says true and earns a secrets key, and the renderer a server serves
 * says nothing (`ServedSignIn.tsx`) and earns none.
 */
async function signedIn(base: string, runsWork: boolean, asABrowser = false): Promise<{ token: string; secretsKey: string | null }> {
  const invited = await call(base, "people:invite", { email: `anna+${runsWork ? "desk" : "browser"}@example.com`, name: "Anna" });
  const invitation = (await invited.json()) as { data: { invitePath: string } };
  const code = invitation.data.invitePath.slice("/invite/".length);

  const accepted = await call(base, "auth:acceptInvitation", { code, kind: "password", password: "a-long-enough-password" });
  expect((await accepted.json()) as { data: { accepted: unknown } }).toMatchObject({ data: { accepted: expect.anything() } });

  const answer = await fetch(`${base}/ipc/auth%3AsignIn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // What a browser cannot help sending, and what a desktop never
      // sends. Both are forbidden header names, so page script can
      // neither forge nor remove them — which is why the door can
      // believe them (EO-328, review).
      ...(asABrowser ? { origin: base, "sec-fetch-site": "same-origin" } : {}),
    },
    body: JSON.stringify({
      payload: {
        email: `anna+${runsWork ? "desk" : "browser"}@example.com`,
        password: "a-long-enough-password",
        deviceName: runsWork ? "annas-macbook" : "annas-browser",
        ...(runsWork ? { runsWork: true } : {}),
      },
    }),
  });
  const body = (await answer.json()) as { data: { session: { token: string; secretsKey: string | null } | null; problem: string | null } };
  if (body.data.session === null) throw new Error(`the sign-in was refused: ${body.data.problem ?? "no reason given"}`);
  return body.data.session;
}

describe("the organisation's secrets, over the wire", () => {
  it("is set by a channel and collected by a path that is not one", async () => {
    const server = start();
    const base = await origin(server);

    const set = await call(base, "policy:setSecret", { name: "FLY_API_TOKEN", value: VALUE });
    expect(await set.json()).toEqual({ ok: true, data: { saved: true, problem: null } });

    // The policy carries the *name*, which is what every desktop draws
    // "set by your organisation · not shown here" from…
    const policy = await call(base, "policy:get", {});
    const body = await policy.text();
    expect(JSON.parse(body)).toMatchObject({ ok: true, data: { policy: { secretNames: ["FLY_API_TOKEN"] } } });
    expect(body).not.toContain(VALUE);

    // …and the value comes over the route, to the operator's own key:
    // the credential the container was started with, which is in nobody's
    // browser.
    const collected = await collect(base, TOKEN);
    expect(collected.status).toBe(200);
    expect(collected.headers.get("cache-control")).toBe("no-store");
    expect(await collected.json()).toEqual({ secrets: { FLY_API_TOKEN: VALUE } });
  });

  it("is not a channel, so nothing can ask for it as one", async () => {
    const server = start();
    const base = await origin(server);

    expect(Object.keys(ipcContract)).not.toContain(ORGANISATION_SECRETS_PATH);
    const asChannel = await call(base, ORGANISATION_SECRETS_PATH, {});
    expect(asChannel.status).toBe(404);
  });

  it("refuses a caller with no token", async () => {
    const server = start();
    const base = await origin(server);
    await call(base, "policy:setSecret", { name: "FLY_API_TOKEN", value: VALUE });

    const anonymous = await collect(base, null);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain(VALUE);
  });

  it("gives a device that runs work its own key, and opens only to that", async () => {
    const server = start();
    const base = await origin(server);
    await call(base, "policy:setSecret", { name: "FLY_API_TOKEN", value: VALUE });
    const desktop = await signedIn(base, true);

    expect(desktop.secretsKey).not.toBeNull();
    expect(desktop.secretsKey).not.toBe(desktop.token);

    const withKey = await collect(base, desktop.secretsKey ?? "");
    expect(withKey.status).toBe(200);
    expect(await withKey.json()).toEqual({ secrets: { FLY_API_TOKEN: VALUE } });
  });

  it("refuses the device's own request token, which is what a renderer holds", async () => {
    // The property the whole second credential exists for. This token is
    // valid — it opens every channel — and it is the thing a served
    // browser keeps in `sessionStorage`. It must not open this.
    const server = start();
    const base = await origin(server);
    await call(base, "policy:setSecret", { name: "FLY_API_TOKEN", value: VALUE });
    const desktop = await signedIn(base, true);

    // The token works, so the refusal below is about the route and not
    // about the credential having gone bad.
    const channel = await call(base, "policy:get", {}, desktop.token);
    expect(channel.status).toBe(200);

    const refused = await collect(base, desktop.token);
    expect(refused.status).toBe(401);
    const said = await refused.text();
    expect(said).not.toContain(VALUE);
    // And it says which credential it wanted, rather than telling a
    // perfectly good device that it has been revoked.
    expect(said).toContain("secrets key");
  });

  it("refuses a browser the key even when it asks for one", async () => {
    // The hole a review found. `runsWork` was a field the client simply
    // asserted, so the renderer this server hands a browser could ask
    // for the credential, read it out of the sign-in *response*, and
    // fetch the organisation's secrets with it. The door takes the claim
    // away from anything that carries browser fetch metadata, and it can
    // only ever take it away.
    const server = start();
    const base = await origin(server);
    await call(base, "policy:setSecret", { name: "FLY_API_TOKEN", value: VALUE });

    const browser = await signedIn(base, true, true);

    // It asked, it signed in, and it was issued nothing.
    expect(browser.token).not.toBe("");
    expect(browser.secretsKey).toBeNull();

    // Its token opens the channels, as it must — a browser is a
    // first-class client of the record.
    expect((await call(base, "policy:get", {}, browser.token)).status).toBe(200);
    // …and it opens nothing here.
    const refused = await collect(base, browser.token);
    expect(refused.status).toBe(401);
    expect(await refused.text()).not.toContain(VALUE);
  });

  it("issues a browser no key at all, so it has nothing to present", async () => {
    const server = start();
    const base = await origin(server);
    await call(base, "policy:setSecret", { name: "FLY_API_TOKEN", value: VALUE });
    const browser = await signedIn(base, false);

    expect(browser.secretsKey).toBeNull();

    // It can read the policy, like any signed-in caller — names only.
    const policy = await call(base, "policy:get", {}, browser.token);
    expect(await policy.text()).not.toContain(VALUE);

    const refused = await collect(base, browser.token);
    expect(refused.status).toBe(401);
    expect(await refused.text()).not.toContain(VALUE);
  });

  it("stops a device's key the moment its row is revoked", async () => {
    const server = start();
    const base = await origin(server);
    await call(base, "policy:setSecret", { name: "FLY_API_TOKEN", value: VALUE });
    const desktop = await signedIn(base, true);
    const devices = (await (await call(base, "devices:list", undefined)).json()) as { data: { devices: { id: string; name: string }[] } };
    const row = devices.data.devices.find((device) => device.name === "annas-macbook");

    await call(base, "devices:revoke", { deviceId: row?.id });

    const refused = await collect(base, desktop.secretsKey ?? "");
    expect(refused.status).toBe(401);
    expect(await refused.text()).not.toContain(VALUE);
  });

  it("answers a POST with the method it takes, rather than with a credential", async () => {
    const server = start();
    const base = await origin(server);

    const posted = await fetch(`${base}${ORGANISATION_SECRETS_PATH}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(posted.status).toBe(405);
  });

  it("forgets a name an admin cleared", async () => {
    const server = start();
    const base = await origin(server);
    await call(base, "policy:setSecret", { name: "FLY_API_TOKEN", value: VALUE });

    const cleared = await call(base, "policy:clearSecret", { name: "FLY_API_TOKEN" });
    expect(await cleared.json()).toEqual({ ok: true, data: { cleared: true, problem: null } });

    const collected = await collect(base, TOKEN);
    expect(await collected.json()).toEqual({ secrets: {} });
  });
});
