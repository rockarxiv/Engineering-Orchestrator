import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ipcContract, MAX_IPC_REQUEST_BYTES } from "@eo/core";
import { clearHandlerRegistry } from "../ipc/registry.js";
import { mcpKeychainStatus } from "../mcp/serverSecrets.js";
import { readApiKey, storeApiKey } from "../runtimes/apiKey.js";
import { createServerSecretStore } from "../secrets/serverStore.js";
import { rotateSecretsCommand, ROTATE_FLAG } from "./rotateCommand.js";
import { sourceTreeResources } from "../testing/platform.js";
import type { ServerConfig } from "./config.js";
import { startServer, type RunningServer } from "./start.js";
import { removeScratch } from "../testing/scratch.js";

/**
 * The server smoke test (EO-319, the story's fourth acceptance
 * criterion).
 *
 * A *real* server, and every word of that is load-bearing: a real
 * `startServer` on an empty directory, real migrations against the
 * migrations in this checkout, a real socket on a free port, and real
 * `fetch` calls over it. Nothing is stubbed between the HTTP request and
 * SQLite, because the thing worth knowing is exactly whether those two
 * ends reach each other on a host with no Electron in it.
 *
 * The mocks below are the teeth, and they are startMain.test.ts's:
 * vitest runs a mock factory the first time something imports the
 * module, so a single `import "electron"` anywhere in the graph this
 * pulls in — however deep, however transitive — fails these tests with
 * the sentence it throws. A server binary that loaded Electron would not
 * be a server binary.
 */
vi.mock("electron", () => {
  throw new Error("The server loaded Electron. A headless host has none.");
});
vi.mock("electron-updater", () => {
  throw new Error("The server loaded electron-updater. A server is updated by whatever installed it.");
});

/**
 * Startup is chatty and some of it arrives late — `checkGitAvailable()`
 * logs whenever git answers, which can be after this file's last test,
 * and a line written during teardown is reported as an
 * `EnvironmentTeardownError` rather than as the harmless thing it is.
 * Silenced for the whole file and never restored, as startMain.test.ts
 * does for the same reason.
 */
beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const TOKEN = "an-admin-token-from-the-environment";

/** 32 bytes, as `EO_SERVER_SECRET_KEY` would carry them (EO-320). */
const SECRET_KEY = Buffer.alloc(32, 7);
/** Somebody else's, for the half of the claim that is about what cannot be read. */
const ANOTHER_KEY = Buffer.alloc(32, 9);

let running: { server: RunningServer; directories: string[] } | null = null;

afterEach(stopRunning);

/**
 * Ends the running server and removes what it wrote.
 *
 * A function rather than only an `afterEach` body because one test
 * restarts the process on the same volume (EO-320), and a restart is
 * precisely this followed by another `start`.
 *
 * @param keepDirectories leave the data directory behind, for a test
 *   that is about to start a second server on it
 */
async function stopRunning(keepDirectories = false): Promise<void> {
  // The registry is module-level for the reason registry.ts gives, so a
  // second `startServer` in one file would find every channel taken.
  clearHandlerRegistry();
  if (!running) return;
  const { server, directories } = running;
  running = null;
  await server.main.stop();
  await server.platform.stopServing();
  // Before the next `start` on the same volume, and before the
  // directory is removed under it: a server holds the data directory
  // while it serves (EO-320).
  server.release();
  if (!keepDirectories) for (const directory of directories) removeScratch(directory);
}

/**
 * A server on a temporary data directory and a free port.
 *
 * Port 0 rather than a number: two of these run in the same suite as
 * everything else in this repository, and a fixed port is how a test
 * suite comes to fail on somebody else's machine for a reason that is
 * not about the code.
 */
function start(overrides: Partial<ServerConfig> = {}, entryDir?: string): { config: ServerConfig; server: RunningServer } {
  const userDataPath = join(mkdtempSync(join(tmpdir(), "eo-server-")), "data");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    // The key the operator configured. There is no keyring on this host,
    // so `readServerConfig` has already refused to start without one —
    // see `secrets/serverKey.ts`.
    secretKey: SECRET_KEY,
    // Deliberately *not* created here. The first acceptance criterion is
    // a clean data directory, and a server handed a path that does not
    // exist yet is the normal case for a freshly mounted volume.
    userDataPath,
    // What the operator said, which is nothing — the same as the shipped
    // command. Where the app comes from is `startServer`'s to work out
    // from `entryDir`, and that resolution is what these tests exercise.
    rendererDirectory: null,
    version: "7.7.7",
    ...overrides,
  };
  const started = startServer(config, {
    resources: sourceTreeResources(),
    exit: () => {},
    ...(entryDir === undefined ? {} : { entryDir }),
  });
  // The helper unwraps, so every test below reads as it did before the
  // data-directory lock arrived. A refusal here is a broken test rather
  // than a case worth asserting on — the cases that are worth asserting
  // on are in `dataDirectoryLock.test.ts` and in the rotation tests.
  if (!started.ok) throw new Error(started.problem);
  const server = started.server;
  running = { server, directories: [join(userDataPath, "..")] };
  return { config, server };
}

/** Where it actually bound. `listen` is asynchronous, so this waits for it. */
async function origin(server: RunningServer): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const address = server.platform.address();
    if (address !== null) return `http://${address.host}:${address.port}`;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The server never bound a port.");
}

function call(base: string, channel: string, init: { token?: string; payload?: unknown; method?: string } = {}): Promise<Response> {
  return fetch(`${base}/ipc/${channel}`, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
    },
    ...(init.method === "GET" ? {} : { body: JSON.stringify({ payload: init.payload }) }),
  });
}

/**
 * The layout a built binary actually runs in.
 *
 * `pnpm build` writes `out/renderer` and `pnpm build:server` writes
 * `out/server/index.js`, so this is those two directories with the same
 * relationship between them. The tests below hand the `out/server` to
 * `startServer` as its entry and configure no renderer at all — which
 * is what `pnpm --filter @eo/desktop start:server` does — so what they cover
 * is the resolution the shipped command performs.
 *
 * The previous version of this helper made one loose directory and
 * passed it in as `rendererDirectory`. Every test here passed while the
 * binary, started the documented way, answered 503 at `/`: the tests
 * covered the static file server and stepped around the question of
 * whether anything ever found it.
 *
 * Registered for cleanup by the caller, like the data directory.
 */
function builtBundle(): { entryDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "eo-out-"));
  const entryDir = join(root, "out", "server");
  const renderer = join(root, "out", "renderer");
  mkdirSync(entryDir, { recursive: true });
  mkdirSync(join(renderer, "assets"), { recursive: true });
  // **Relative asset URLs, because that is what `electron-vite` emits.**
  // The desktop loads this page through `loadFile`, where a leading `/`
  // would mean the root of the filesystem, so the built page says
  // `./assets/…` and the server has to cope with that.
  //
  // The previous fixture was `<!doctype html><title>EO</title><div
  // id=root></div>` — no script, no stylesheet, nothing to resolve. So
  // the deep-link test asserted the fallback returned *the page*, which
  // it did, while every real deep link served a blank screen because
  // both of its assets 404'd one directory down. A fixture that cannot
  // exhibit the bug cannot catch it.
  writeFileSync(
    join(renderer, "index.html"),
    '<!doctype html><html lang="en"><head><meta charset="UTF-8" />' +
      '<script type="module" crossorigin src="./assets/index-a1b2.js"></script>' +
      '<link rel="stylesheet" crossorigin href="./assets/index-c3d4.css" />' +
      "</head><body><div id=root></div></body></html>",
  );
  writeFileSync(join(renderer, "assets", "index-a1b2.js"), "export const built = true;\n");
  writeFileSync(join(renderer, "assets", "index-c3d4.css"), ":root { color: black }\n");
  return { entryDir, root };
}

/**
 * Every asset a page asks for, resolved the way the browser that was
 * handed it would.
 *
 * `new URL(reference, pageUrl)` is the whole point: a relative reference
 * means something different at `/` than at `/items/01a0…`, and resolving
 * it against the address the page was served from is what a browser
 * does and what this test has to do to be about anything.
 */
function assetsAskedFor(html: string, pageUrl: string): string[] {
  const base = /<base\b[^>]*href="([^"]*)"/i.exec(html)?.[1];
  const against = base === undefined ? pageUrl : new URL(base, pageUrl).href;
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1] ?? "")
    .filter((reference) => reference.includes("assets/"))
    .map((reference) => new URL(reference, against).href);
}

/** Starts a server the way the shipped command does, on a built layout. */
function startOnBundle(): { server: RunningServer; root: string } {
  const bundle = builtBundle();
  const { server } = start({}, bundle.entryDir);
  running?.directories.push(bundle.root);
  return { server, root: bundle.root };
}

describe("an organisation server, started on a clean data directory", () => {
  it("migrates and answers a record channel over HTTP with the token", async () => {
    const { config, server } = start();
    const base = await origin(server);

    // Migrated: the file did not exist a moment ago, and neither did the
    // directory holding it.
    expect(existsSync(join(config.userDataPath, "eo.db"))).toBe(true);

    const response = await call(base, "projects:list", { token: TOKEN, payload: undefined });

    expect(response.status).toBe(200);
    // A real answer from tables that exist only because the migrations
    // in `sourceTreeResources()` ran when this server started.
    await expect(response.json()).resolves.toEqual({ ok: true, data: { projects: [], activeProjectId: null } });
  });

  it("answers the machine's own facts from the server's platform, not a desktop's", async () => {
    const { server } = start();
    const base = await origin(server);

    const response = await call(base, "app:getVersion", { token: TOKEN, payload: undefined });

    await expect(response.json()).resolves.toEqual({ ok: true, data: { version: "7.7.7" } });
  });

  it("answers 401 without the token, and with the wrong one", async () => {
    const { server } = start();
    const base = await origin(server);

    for (const token of [undefined, "", "not-the-token", `${TOKEN}-and-more`]) {
      const response = await call(base, "projects:list", { ...(token === undefined ? {} : { token }), payload: undefined });

      expect(response.status, `token: ${String(token)}`).toBe(401);
      // One sentence for every 401, whatever was wrong with the token
      // (EO-323): no token, a token that was never issued, a device an
      // admin revoked. Telling them apart is how a caller learns which
      // tokens once existed.
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("did not accept that token") },
      });
    }
  });

  it("checks the token before anything else, so a refusal says nothing about the channel", async () => {
    const { server } = start();
    const base = await origin(server);

    // A channel that exists, one that does not, and one from the other
    // half. All three are the same 401 with the same body — an answer
    // that varied here is a way to map the contract without a token.
    const bodies = await Promise.all(
      ["projects:list", "not:a-channel", "worktrees:list"].map(async (channel) => (await call(base, channel, { payload: undefined })).text()),
    );

    expect(new Set(bodies).size).toBe(1);
  });

  it("refuses a machine channel with the typed refusal rather than an error", async () => {
    const { server } = start();
    const base = await origin(server);

    const response = await call(base, "worktrees:list", { token: TOKEN, payload: { repositoryId: null } });

    // 200, because the envelope is the contract: the call reached the
    // server, was understood, and was answered. What it was answered
    // with is a refusal a caller can branch on.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "machine-only", message: expect.stringContaining('"worktrees:list" is not available on a server') },
    });
  });

  it("refuses to reveal a secret, as the machine half it is (EO-489)", async () => {
    const { server } = start();
    const base = await origin(server);

    // A personal secret is shown on the desktop it is stored on and
    // nowhere else, so a browser served by a server is refused both.
    for (const [channel, payload] of [
      ["moduleSecrets:reveal", { name: "FLY_API_TOKEN" }],
      ["mcpServers:revealSecret", { serverId: "01a01be7-2005-7335-ac8b-11c395830f54", name: "GITHUB_TOKEN" }],
    ] as const) {
      const response = await call(base, channel, { token: TOKEN, payload });

      expect(response.status, channel).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: { code: "machine-only", message: expect.stringContaining(`"${channel}" is not available on a server`) },
      });
    }
  });

  it("says a channel does not exist differently from a channel it will not answer", async () => {
    const { server } = start();
    const base = await origin(server);

    const response = await call(base, "worktrees:invented", { token: TOKEN, payload: {} });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("no channel") } });
    // And carries no code: this is not a refusal, it is a mistake.
    await expect(call(base, "worktrees:invented", { token: TOKEN, payload: {} }).then((r) => r.json())).resolves.not.toHaveProperty("error.code");
  });

  it("answers a malformed request without letting it reach a handler", async () => {
    const { server } = start();
    const base = await origin(server);

    const notJson = await fetch(`${base}/ipc/projects:list`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(notJson.status).toBe(400);

    // And the contract's own validation still applies underneath, which
    // is the point of dispatching through `handleIpcRequest`: a payload
    // that is JSON but not this channel's is an envelope, not a 400.
    const wrongShape = await call(base, "costs:getForItem", { token: TOKEN, payload: { nonsense: true } });
    expect(wrongShape.status).toBe(200);
    await expect(wrongShape.json()).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("Invalid request payload") } });
  });

  it("carries an attachment as large as the contract allows", async () => {
    const { server } = start();
    const base = await origin(server);

    // The regression this exists for: the door capped every body at
    // 8 MiB while `attachments:stage` accepts a 20 MiB file as base64,
    // so anything bigger than about 6 MB came back 413 before a schema
    // could look at it. That is the renderer's whole paste-and-drop path
    // on a server, and neither the desktop nor any other test reads a
    // request off a socket, so nothing else could have caught it.
    //
    // Twelve mebibytes rather than the full maximum: it is comfortably
    // over the cap that was wrong, it is a real file staged to real disk,
    // and it does not spend half a minute of every suite run moving 28 MB
    // of base64 through JSON twice. The exact ceiling is arithmetic, and
    // `packages/core/src/ipc.test.ts` checks that against the schema.
    const bytes = Buffer.alloc(12 * 1024 * 1024, 7);

    const response = await call(base, "attachments:stage", {
      token: TOKEN,
      payload: { name: "big.bin", dataBase64: bytes.toString("base64") },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { attachment: { name: "big.bin", size: bytes.byteLength } } });
  });

  it("carries a text request far larger than any attachment-derived cap", async () => {
    const { server } = start();
    const base = await origin(server);

    // The second thing got wrong here, and the reason the cap is no
    // longer read off one channel: `items:setOutput.body` is a record
    // field with no `.max()` of its own, so a cap derived from
    // `attachments:stage` was a cap this request had never heard of. Ten
    // mebibytes of text is past the 8 MiB the door first allowed and
    // nowhere near what it carries now.
    const response = await call(base, "items:setOutput", {
      token: TOKEN,
      payload: { itemId: "01a09000-0000-7000-8000-000000000000", body: "x".repeat(10 * 1024 * 1024) },
    });

    // 200 and an envelope: the door read it, the contract accepted it,
    // and whatever the handler then made of a conversation that does not
    // exist is the handler's business and not this test's. What is being
    // asserted is that it was never refused for its size.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toHaveProperty("ok");
  });

  it("agrees with the contract about where the limit is", async () => {
    const { server } = start();
    const base = await origin(server);

    // The two have to draw the line in the same place and in the same
    // unit, or one of them refuses what the other accepts. A body of
    // declared content one byte past the contract's maximum is refused
    // by both; this asserts the door does not draw it *earlier*, which
    // is the failure that is invisible from the outside.
    const body = "x".repeat(MAX_IPC_REQUEST_BYTES + 1);

    expect(ipcContract["items:setOutput"].request.safeParse({ itemId: "c", body }).success).toBe(false);

    const justUnder = "x".repeat(MAX_IPC_REQUEST_BYTES - 1024);
    const response = await call(base, "items:setOutput", {
      token: TOKEN,
      payload: { itemId: "01a09000-0000-7000-8000-000000000000", body: justUnder },
    });

    expect(response.status).not.toBe(413);
  });

  it("still refuses a body past the contract's own maximum", async () => {
    const { server } = start();
    const base = await origin(server);

    // The cap is a cap. Sent as a raw body rather than through a staged
    // attachment, so this stays about the door: nobody may make this
    // process hold a gigabyte by claiming a channel. A mebibyte past the
    // contract's own maximum, so it is refused for its size and not for
    // anything a schema would have said about it.
    const outcome = await fetch(`${base}/ipc/attachments:stage`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: `{"payload":{"name":"x","dataBase64":"${"A".repeat(MAX_IPC_REQUEST_BYTES + 1024 * 1024)}"}}`,
    }).then((response) => `status ${response.status}`, () => "the socket was dropped");

    // The body is destroyed the moment it goes over rather than read to
    // the end, so `fetch` may see the socket go before the status
    // arrives. Both are the refusal; asserting one *of the two* rather
    // than tolerating anything, because a test whose failure branch is
    // `if (response !== null)` passes when nothing happened at all.
    expect(["status 413", "the socket was dropped"]).toContain(outcome);
  });

  it("answers a broken percent-escape, and is still there afterwards", async () => {
    const { server } = start();
    const base = await origin(server);

    // `decodeURIComponent("%")` throws a `URIError`, and a throw inside
    // the discarded promise this listener returned was an unhandled
    // rejection — which since Node 15 ends the process. One typed address
    // would have taken the server down and every run on it with it.
    const broken = await fetch(`${base}/ipc/%`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });

    expect(broken.status).toBe(400);
    await expect(broken.json()).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("percent-escapes") } });

    // The assertion the bug was actually about: the process is alive and
    // the next caller is answered. A 400 that arrived from a dying server
    // would have passed the line above on its own.
    const after = await call(base, "projects:list", { token: TOKEN, payload: undefined });
    expect(after.status).toBe(200);
    await expect(after.json()).resolves.toMatchObject({ ok: true });
  });

  it("takes a POST and says so to anything else", async () => {
    const { server } = start();
    const base = await origin(server);

    const response = await call(base, "projects:list", { token: TOKEN, method: "GET" });

    expect(response.status).toBe(405);
  });
});

/**
 * The story's first acceptance criterion, over a real socket (EO-323,
 * the original design).
 *
 * "An invited person accepts, signs in from a desktop, and appears with
 * a device in the admin's list; revoking the device makes its next
 * request fail with 401."
 *
 * Every step of it through the door rather than through the functions
 * behind it, because what is being proved is the part no unit test can
 * reach: that the two channels a caller reaches *without* a token are
 * reachable without one, that the token they earn opens everything else,
 * and that revoking closes it again on the very next request.
 */
describe("signing in to an organisation server", () => {
  const PASSWORD = "a memorable passphrase";

  /** Calls a channel with no credential at all — which is what a stranger with a link has. */
  function callOpen(base: string, channel: string, payload: unknown): Promise<Response> {
    return call(base, channel, { payload });
  }

  async function data(response: Response): Promise<Record<string, unknown>> {
    const body = (await response.json()) as { ok: boolean; data?: Record<string, unknown>; error?: { message: string } };
    if (!body.ok) throw new Error(body.error?.message ?? "refused");
    return body.data ?? {};
  }

  it("carries somebody from an invitation to a device, and takes the key back", async () => {
    const { server } = start();
    const base = await origin(server);

    // The operator's token is what an admin has on a server whose people
    // list is empty — which is every server on its first boot, since the
    // first invitation has to be written by somebody.
    const invited = await data(await call(base, "people:invite", { token: TOKEN, payload: { email: "anna@example.com", name: "Anna Ruiz" } }));
    expect(invited["problem"]).toBeNull();
    const invitePath = String(invited["invitePath"]);
    expect(invitePath.startsWith("/invite/")).toBe(true);

    // Accepted from a browser that has no token and is nobody yet. The
    // code in the link is the whole of what admits it.
    const code = decodeURIComponent(invitePath.slice("/invite/".length));
    const accepted = await data(await callOpen(base, "auth:acceptInvitation", { code, password: PASSWORD }));
    expect(accepted["accepted"]).toMatchObject({ email: "anna@example.com" });

    // Signed in from a desktop, which also carries no token yet.
    const signedIn = await data(await callOpen(base, "auth:signIn", { email: "anna@example.com", password: PASSWORD, deviceName: "anna-macbook" }));
    const session = signedIn["session"] as { token: string; deviceId: string; person: { name: string } };
    expect(session.person.name).toBe("Anna Ruiz");

    // The device token opens the record, which is what a device token is.
    const asAnna = await call(base, "projects:list", { token: session.token, payload: undefined });
    expect(asAnna.status).toBe(200);
    await expect(asAnna.json()).resolves.toMatchObject({ ok: true });

    // And she is in the admin's list, with the machine she signed in
    // from and when it was last seen — which is the request above.
    const listed = await data(await call(base, "devices:list", { token: TOKEN, payload: undefined }));
    expect(listed["devices"]).toMatchObject([{ name: "anna-macbook", personName: "Anna Ruiz", revokedAt: null, lastSeenAt: expect.any(Number) }]);

    // Revoked by the admin.
    const revoked = await data(await call(base, "devices:revoke", { token: TOKEN, payload: { deviceId: session.deviceId } }));
    expect(revoked["device"]).toMatchObject({ name: "anna-macbook", revokedAt: expect.any(Number) });

    // Its next request fails with 401 — the half of the criterion that
    // only a real socket can show.
    const after = await call(base, "projects:list", { token: session.token, payload: undefined });
    expect(after.status).toBe(401);
    // The same sentence an unknown token gets, because "revoked" and
    // "never issued" must not be told apart from outside.
    const stranger = await call(base, "projects:list", { token: "a-token-nobody-issued", payload: undefined });
    await expect(after.text()).resolves.toBe(await stranger.text());

    // And the row stays in the list, because the list is a record of
    // what has held a key.
    const stillListed = await data(await call(base, "devices:list", { token: TOKEN, payload: undefined }));
    expect(stillListed["devices"]).toMatchObject([{ name: "anna-macbook", revokedAt: expect.any(Number) }]);
  });

  it("answers a record request as the device that made it, not as the one it names", async () => {
    // The identity half of managed mode, over a real socket (EO-324,
    // ARCHITECTURE.md, "The record"). Two devices sign in to one server; one of them sends a
    // record request naming the other.
    //
    // A `deviceId` in one of these payloads is not information — it
    // claims work, keeps or gives back a claim, and files history under
    // a machine's name. A door that believed it would let any signed-in
    // device take another's lease and sign another's transcript, from a
    // token that is perfectly valid for itself.
    const { server } = start();
    const base = await origin(server);

    const sessions: Record<string, { token: string; deviceId: string }> = {};
    for (const [name, email] of [["anna", "anna@example.com"], ["dana", "dana@example.com"]] as const) {
      const invited = await data(await call(base, "people:invite", { token: TOKEN, payload: { email, name } }));
      const code = decodeURIComponent(String(invited["invitePath"]).slice("/invite/".length));
      await callOpen(base, "auth:acceptInvitation", { code, password: PASSWORD });
      const signedIn = await data(await callOpen(base, "auth:signIn", { email, password: PASSWORD, deviceName: `${name}-laptop` }));
      sessions[name] = signedIn["session"] as { token: string; deviceId: string };
    }
    const anna = sessions["anna"]!;
    const dana = sessions["dana"]!;
    expect(anna.deviceId).not.toBe(dana.deviceId);

    // Dana's token, Anna's name in the payload. There is nothing to
    // dispatch on this server, so what is asserted is whose renewal it
    // was — `record:renew` answers the claims the *caller* holds, and
    // with `releaseOthers` it hands back everything else of theirs.
    const renewed = await data(
      await call(base, "record:renew", {
        token: dana.token,
        payload: { deviceId: anna.deviceId, itemIds: [], releaseOthers: true },
      }),
    );
    expect(renewed).toMatchObject({ held: [], released: [] });

    // And the work: asked for by Dana under Anna's name, granted to
    // Dana or to nobody — never to Anna.
    const offered = await data(
      await call(base, "record:work", { token: dana.token, payload: { deviceId: anna.deviceId, capacity: 1 } }),
    );
    for (const offer of offered["offers"] as { lease: { deviceId: string } }[]) {
      expect(offer.lease.deviceId).toBe(dana.deviceId);
    }

    // The operator's key is the one that belongs to no machine: it
    // administers the organisation and cannot *be* a device, because
    // there is no laptop behind it to run anything.
    const asOperator = await call(base, "record:work", { token: TOKEN, payload: { deviceId: anna.deviceId, capacity: 1 } });
    expect(asOperator.status).toBe(200);
    await expect(asOperator.json()).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("signed-in device") } });
  });

  it("lets nobody but the two front-door channels past the token", async () => {
    const { server } = start();
    const base = await origin(server);

    // The rule that has one written-down exception: a caller with no
    // token learns nothing about what exists. `people:list` is a record
    // channel and is refused; `auth:signIn` is reached and answers on
    // its merits, which for a server with nobody on it is "no".
    const refused = await callOpen(base, "people:list", undefined);
    expect(refused.status).toBe(401);

    const attempted = await callOpen(base, "auth:signIn", { email: "nobody@example.com", password: "x", deviceName: "a-laptop" });
    expect(attempted.status).toBe(200);
    await expect(attempted.json()).resolves.toMatchObject({ ok: true, data: { session: null, problem: expect.stringContaining("do not match") } });
  });

  it("keeps the organisation's list to its administrators", async () => {
    const { server } = start();
    const base = await origin(server);

    // Invited without the flag, which is what most people are.
    const invited = await data(await call(base, "people:invite", { token: TOKEN, payload: { email: "anna@example.com" } }));
    const code = decodeURIComponent(String(invited["invitePath"]).slice("/invite/".length));
    await callOpen(base, "auth:acceptInvitation", { code, password: PASSWORD });
    const signedIn = await data(await callOpen(base, "auth:signIn", { email: "anna@example.com", password: PASSWORD, deviceName: "anna-macbook" }));
    const token = (signedIn["session"] as { token: string }).token;

    // She can work — the record is what she signed in for.
    expect((await call(base, "projects:list", { token, payload: undefined })).status).toBe(200);

    // She cannot invite, and cannot revoke. "One admin flag. Everyone
    // with it may edit on the server" (the original design), enforced at the door
    // because the door is the only place there is a caller to ask about.
    const invite = await call(base, "people:invite", { token, payload: { email: "someone@example.com" } });
    expect(invite.status).toBe(200);
    await expect(invite.json()).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("only an administrator") } });

    const revoke = await call(base, "devices:revoke", { token, payload: { deviceId: "any" } });
    await expect(revoke.json()).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("only an administrator") } });
  });

  it("lets an admin's own device do what the operator's token does", async () => {
    const { server } = start();
    const base = await origin(server);

    const invited = await data(await call(base, "people:invite", { token: TOKEN, payload: { email: "dana@example.com", isAdmin: true } }));
    const code = decodeURIComponent(String(invited["invitePath"]).slice("/invite/".length));
    await callOpen(base, "auth:acceptInvitation", { code, password: PASSWORD });
    const signedIn = await data(await callOpen(base, "auth:signIn", { email: "dana@example.com", password: PASSWORD, deviceName: "dana-desktop" }));
    const token = (signedIn["session"] as { token: string }).token;

    const listed = await data(await call(base, "people:list", { token, payload: undefined }));
    expect((listed["people"] as { email: string | null }[]).map((person) => person.email)).toContain("dana@example.com");

    const invite = await data(await call(base, "people:invite", { token, payload: { email: "bo@example.com" } }));
    expect(invite["problem"]).toBeNull();
  });
});

describe("the renderer, served from the server", () => {
  it("serves the app at `/` with nothing configured, as the shipped command starts it", async () => {
    // The acceptance criterion this is here for: "the admin opens its
    // address in a browser and sees the app". No `EO_SERVER_RENDERER`,
    // no `--renderer` — the binary finds `out/renderer` beside the
    // `out/server` it was loaded from, exactly as it finds its
    // migrations.
    const { server } = startOnBundle();
    const base = await origin(server);

    const root = await fetch(base);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    await expect(root.text()).resolves.toContain("<div id=root>");

    // A real asset.
    const asset = await fetch(`${base}/assets/index-a1b2.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");

    // A route inside the single-page app, which is not a file.
    const route = await fetch(`${base}/items/01a09000-0000-7000-8000-000000000000`);
    expect(route.status).toBe(200);
    await expect(route.text()).resolves.toContain("<div id=root>");
  });

  it("gives a deep link assets it can actually fetch", async () => {
    const { server } = startOnBundle();
    const base = await origin(server);
    const deepLink = `${base}/items/01a09000-0000-7000-8000-000000000000`;

    const html = await (await fetch(deepLink)).text();
    const assets = assetsAskedFor(html, deepLink);

    // Two of them, and both under `/assets/` rather than under the route
    // — which is the assertion that would have failed before, when the
    // page's own `./assets/…` resolved to `/items/assets/…`.
    expect(assets).toEqual([`${base}/assets/index-a1b2.js`, `${base}/assets/index-c3d4.css`]);

    // And actually fetched, because a URL that merely looks right is
    // what the previous version of this test was checking.
    for (const asset of assets) {
      const response = await fetch(asset);

      expect(response.status, asset).toBe(200);
    }
  });

  it("resolves a deep link's assets the same way from any depth", async () => {
    const { server } = startOnBundle();
    const base = await origin(server);

    // One segment, three segments, and a trailing slash — a person's
    // bookmark, a link somebody pasted, and the address bar after a
    // route change. A `<base href="/">` makes all of them the same;
    // a relative reference makes all of them different, and all wrong.
    for (const route of ["/items", "/items/01a0/runs/7", "/settings/"]) {
      const url = `${base}${route}`;
      const html = await (await fetch(url)).text();

      expect(assetsAskedFor(html, url), route).toEqual([`${base}/assets/index-a1b2.js`, `${base}/assets/index-c3d4.css`]);
    }
  });

  it("leaves the built page on disk exactly as the desktop loads it", async () => {
    const { server, root } = startOnBundle();
    await origin(server);

    // The rewrite is the server's copy and nothing else. `out/renderer`
    // is the same directory Electron loads through `loadFile`, where an
    // absolute `/assets/…` would mean the root of the disk — so a fix
    // that edited the build, or this file, would break the desktop while
    // every test here went on passing.
    const onDisk = readFileSync(join(root, "out", "renderer", "index.html"), "utf8");

    expect(onDisk).toContain('src="./assets/index-a1b2.js"');
    expect(onDisk).not.toContain("<base");
  });

  it("serves it without the token, and the record never", async () => {
    const { server } = startOnBundle();
    const base = await origin(server);

    // The bundle is the same bundle the desktop ships and holds no
    // record. The token gates the data, which is `/ipc/…`.
    expect((await fetch(base)).status).toBe(200);
    expect((await call(base, "projects:list", { payload: undefined })).status).toBe(401);
  });

  it("does not answer the app to a missing asset", async () => {
    const { server } = startOnBundle();
    const base = await origin(server);

    // A browser handed HTML where it asked for a module reports a syntax
    // error in a file that is not the problem.
    expect((await fetch(`${base}/assets/index-gone.js`)).status).toBe(404);
  });

  it("serves nothing outside the directory it was given", async () => {
    const { server } = startOnBundle();
    const base = await origin(server);

    for (const path of ["/../../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/assets/../../etc/passwd"]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });
      // Either the app (a path that is not a file under the root) or a
      // 404 — never a file from above it.
      expect([200, 404], path).toContain(response.status);
      if (response.status === 200) await expect(response.text()).resolves.not.toContain("root:");
    }
  });

  it("says so when there is no renderer beside it to find", async () => {
    // A checkout where `pnpm build` has not run. Still a real state, and
    // still answered with a sentence rather than a blank page — but no
    // longer what the shipped command produces, which is the whole of
    // what changed here.
    const { server } = start({}, join(mkdtempSync(join(tmpdir(), "eo-nobuild-")), "out", "server"));
    const base = await origin(server);

    const response = await fetch(base);

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toContain("EO_SERVER_RENDERER");
  });

  it("takes a renderer somewhere else when it is pointed at one", async () => {
    // `EO_SERVER_RENDERER` has not gone away; it has stopped being the
    // only way. A layout that puts the app somewhere other than beside
    // the binary still works.
    const elsewhere = builtBundle();
    const { server } = start({ rendererDirectory: join(elsewhere.root, "out", "renderer") }, join(mkdtempSync(join(tmpdir(), "eo-elsewhere-")), "out", "server"));
    running?.directories.push(elsewhere.root);
    const base = await origin(server);

    const response = await fetch(base);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("<div id=root>");
  });
});

/**
 * The server's own keychain, on a real server (EO-320, the story's
 * first acceptance criterion).
 *
 * At the store's own level this is `secrets/serverStore.test.ts`. Here
 * it is the claim the story actually makes: a secret written through
 * the platform a running server was composed with, by the consumer that
 * writes it in production, survives that process ending and the next
 * one starting on the same volume — and is bytes to anybody without the
 * key.
 */
describe("the secrets an organisation server keeps", () => {
  const CREDENTIAL = join("credentials", "runtime-claude-api-key.bin");
  const KEY_NOBODY_SHOULD_READ = "sk-ant-this-is-not-a-real-key";

  it("keeps a secret across a restart, and keeps it from anybody without the key", async () => {
    const { config, server } = start();
    const credentials = join(config.userDataPath, "credentials");
    await origin(server);

    // The real consumer, not a fake one: `runtimes/apiKey.ts` is what
    // holds the one billable secret EO stores, and it was written
    // against `safeStorage` without knowing this exists.
    expect(storeApiKey({ directory: credentials, store: server.platform.keychain }, "claude", KEY_NOBODY_SHOULD_READ)).toEqual({ ok: true });

    // The process ends. Nothing is carried over in memory — the second
    // server builds its store from the key alone, which is all an
    // operator's environment hands a fresh container.
    await stopRunning(true);
    const second = start({ userDataPath: config.userDataPath, secretKey: Buffer.from(SECRET_KEY) });
    await origin(second.server);

    expect(readApiKey({ directory: credentials, store: second.server.platform.keychain }, "claude")).toBe(KEY_NOBODY_SHOULD_READ);

    const onDisk = readFileSync(join(config.userDataPath, CREDENTIAL));
    // Not in the clear, and not openable by a key that is not the one it
    // was written under — which is the whole of what "encrypted at rest"
    // has to mean on a volume somebody else can back up.
    expect(onDisk.includes(KEY_NOBODY_SHOULD_READ)).toBe(false);
    expect(() => createServerSecretStore(ANOTHER_KEY).decryptString(onDisk)).toThrow();
  });

  it("will not rotate the volume a server is serving, and takes it once the server stops", async () => {
    const { config, server } = start();
    const credentials = join(config.userDataPath, "credentials");
    await origin(server);
    const environment = {
      EO_SERVER_DATA: config.userDataPath,
      EO_SERVER_SECRET_KEY: SECRET_KEY.toString("base64"),
      EO_SERVER_NEW_SECRET_KEY: ANOTHER_KEY.toString("base64"),
    };

    // The race this closes, in the order it happens. Rotation scans a
    // volume, and a server holding the old key in memory writes a secret
    // immediately afterwards — on a real installation, somebody saving
    // an API key while the admin runs the command. Reported as a success,
    // that value would be one the old key still opens on a volume EO had
    // just said was rotated.
    const refused = rotateSecretsCommand(environment, [ROTATE_FLAG]);
    expect(storeApiKey({ directory: credentials, store: server.platform.keychain }, "claude", "saved-while-serving")).toEqual({ ok: true });

    expect(refused.ok).toBe(false);
    expect(refused.lines[0]).toContain("A server");
    expect(refused.lines[0]).toContain(config.userDataPath);

    // Stopped, so the directory is nobody's. The same command now takes
    // the value that was written during the refused attempt, which is
    // the whole point of having refused it.
    await stopRunning(true);
    const done = rotateSecretsCommand(environment, [ROTATE_FLAG]);

    expect(done.ok).toBe(true);
    expect(readApiKey({ directory: credentials, store: createServerSecretStore(ANOTHER_KEY) }, "claude")).toBe("saved-while-serving");
    expect(readApiKey({ directory: credentials, store: createServerSecretStore(SECRET_KEY) }, "claude")).toBeNull();
    removeScratch(join(config.userDataPath, ".."));
  });

  it("refuses to start a second server on a directory one is already serving", async () => {
    const { config, server } = start();
    await origin(server);

    // The other half of the same lock. Two servers on one SQLite file is
    // its own problem; this one is EO-320's, because the second would
    // hold the same secrets open while a rotation believed the volume
    // was idle.
    const second = startServer({ ...config }, { resources: sourceTreeResources(), exit: () => {} });

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.problem).toContain("A server");
  });

  it("presents a keychain the existing consumers are content with", async () => {
    const { server } = start();
    await origin(server);

    // The refusals every consumer shows a desktop with no keyring —
    // "EO cannot store this safely" — are keyed on exactly this, and a
    // server that answered as a broken desktop does would store nothing
    // at all while reporting itself healthy.
    expect(mcpKeychainStatus(server.platform.keychain)).toEqual({ available: true, backend: "eo_server_key", weak: false, warning: null });
  });
});
