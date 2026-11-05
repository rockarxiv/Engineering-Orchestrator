import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridge, machineAvailable, setBridge } from "./bridge";

/**
 * The renderer's two transports (EO-319, `ARCHITECTURE.md`, "The server").
 *
 * The same bundle runs in a `BrowserWindow` with a preload in front of
 * it and in a browser with a socket behind it, and every screen is
 * written against neither. These are the tests of the one file that
 * knows the difference.
 */
afterEach(() => {
  // The choice is made once per page load, which is right for a page and
  // wrong for a file that has to describe both.
  setBridge(undefined);
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("choosing a transport at startup", () => {
  it("uses the preload's bridge under Electron, and says the machine is here", async () => {
    // `window.eo` is what setupTests.ts puts in front of every renderer
    // test, which is what the preload puts in front of the real one.
    expect(machineAvailable()).toBe(true);

    await bridge().invoke("app:getVersion", undefined);

    expect(window.eo.ipc.invoke).toHaveBeenCalledWith("app:getVersion", undefined);
  });

  it("uses HTTP where there is no preload, and says the machine is not", () => {
    withoutPreload();

    expect(machineAvailable()).toBe(false);
  });

  it("chooses once and does not look again", () => {
    const first = bridge();

    // The preload going away mid-session, which cannot happen — but a
    // transport resolved per call could be made to change by anything,
    // and a renderer whose transport changed would have screens drawn
    // for one and data from the other.
    forgetPreload();

    expect(bridge()).toBe(first);
    expect(machineAvailable()).toBe(true);
  });
});

describe("the HTTP transport", () => {
  it("refuses a machine channel without spending a round trip", async () => {
    withoutPreload();
    const fetched = stubFetch();

    const result = await bridge().invoke("worktrees:list", { repositoryId: null });

    expect(result).toEqual({ ok: false, error: { code: "machine-only", message: expect.stringContaining("worktrees:list") } });
    // The server would have answered exactly this. Asking it anyway
    // would be a round trip to be told what this side already knows.
    expect(fetched).not.toHaveBeenCalled();
  });

  it("posts a record channel to its own origin, with the token as a bearer", async () => {
    arriveWithToken("a-token");
    const fetched = stubFetch({ ok: true, data: { projects: [], activeProjectId: null } });

    const result = await bridge().invoke("projects:list", undefined);

    expect(fetched).toHaveBeenCalledWith(
      "/ipc/projects%3Alist",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer a-token" }),
        body: JSON.stringify({ payload: undefined }),
      }),
    );
    expect(result).toEqual({ ok: true, data: { projects: [], activeProjectId: null } });
  });

  it("takes the token out of the URL it arrived in", async () => {
    arriveWithToken("a-token");
    stubFetch({ ok: true, data: {} });

    await bridge().invoke("projects:list", undefined);

    // Kept for the tab…
    expect(window.sessionStorage.getItem("eo.serverToken")).toBe("a-token");
    // …and gone from the address bar, so it is not copied into a chat
    // window with the link.
    expect(window.history.replaceState).toHaveBeenCalledWith(null, "", "http://eo.example/items");
  });

  it("says what is missing when no token ever arrived", async () => {
    withoutPreload();
    const fetched = stubFetch();

    const result = await bridge().invoke("projects:list", undefined);

    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("admin token") } });
    expect(fetched).not.toHaveBeenCalled();
  });

  it("accepts an invitation from a link that carries no token at all (EO-323)", async () => {
    // The whole of the invitation flow, from this side. A colleague
    // opens `/invite/<code>` — the link `people:invite` actually
    // produces — and has no token, has never had one, and is not
    // supposed to: the code in the link is what admits them.
    //
    // This transport used to demand a token before every request, which
    // answered them "open the address the server printed" — the admin's
    // address, which they do not have — and the request never reached
    // the channel the server had deliberately left unauthenticated.
    arriveOnAnInviteLink();
    const fetched = stubFetch({ ok: true, data: { accepted: { personId: "p1", name: "Anna Ruiz", email: "anna@example.com", credentialKind: "password" }, problem: null } });

    const result = await bridge().invoke("auth:acceptInvitation", { code: "a-one-time-code", password: "a memorable passphrase" });

    expect(result).toMatchObject({ ok: true, data: { accepted: { name: "Anna Ruiz" } } });
    // Sent, and sent with no `Authorization` at all — `Bearer null` is a
    // token, and a wrong one.
    expect(fetched).toHaveBeenCalledWith("/ipc/auth%3AacceptInvitation", expect.objectContaining({ method: "POST" }));
    const headers = (fetched.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(headers).not.toHaveProperty("authorization");
  });

  it("lets a sign-in through without one too, and nothing else", async () => {
    // The other of the two, and the rule around them: this side keeps
    // the rule the server's door keeps, out of the same list.
    arriveOnAnInviteLink();
    const fetched = stubFetch({ ok: true, data: { session: null, problem: "That email address and password do not match anybody on this server." } });

    await bridge().invoke("auth:signIn", { email: "anna@example.com", password: "not it", deviceName: "a-browser" });
    expect(fetched).toHaveBeenCalledTimes(1);

    const refused = await bridge().invoke("agents:list", undefined);

    expect(refused).toMatchObject({ ok: false, error: { message: expect.stringContaining("admin token") } });
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("keeps an open channel unauthenticated even in a tab that holds a token", async () => {
    // An admin trying the link they have just sent, in the window they
    // are administering the server from. Nothing is presented, so a 401
    // about somebody's expired code cannot sign them out of their own
    // tab — which is the ambiguity that not reading the token here
    // removes rather than handles.
    arriveOnAnInviteLink();
    // As the tab holds it once any authenticated call has been made.
    window.sessionStorage.setItem("eo.serverToken", "a-token");
    const fetched = stubFetch({}, 401);

    await bridge().invoke("auth:acceptInvitation", { code: "stale", password: "a memorable passphrase" });

    const headers = (fetched.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(headers).not.toHaveProperty("authorization");
    expect(window.sessionStorage.getItem("eo.serverToken")).toBe("a-token");
  });

  it("forgets a token the server has stopped accepting", async () => {
    arriveWithToken("stale");
    stubFetch({}, 401);

    const result = await bridge().invoke("projects:list", undefined);

    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("did not accept") } });
    // Otherwise it would be resent on every query for the rest of the
    // session, and every screen would show the same refusal for ever.
    expect(window.sessionStorage.getItem("eo.serverToken")).toBeNull();
  });

  it("turns a network failure into an envelope rather than a rejection", async () => {
    arriveWithToken("a-token");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

    // The envelope is the contract on this side too (F-04). A renderer
    // that had to catch exceptions from one transport and read envelopes
    // from the other would be two renderers.
    await expect(bridge().invoke("projects:list", undefined)).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("connection refused") },
    });
  });

});

/**
 * Push, over the transport that is not `webContents` (EO-321).
 *
 * The stream itself is `pushStream.test.ts`'s, the server's end of the
 * wire is `main/server/pushStream.test.ts`'s, and the whole path —
 * two browsers, two boards, a change in one appearing in the other — is
 * `servedClients.test.tsx`'s. What is left here is the part only this
 * file does: turning one stream into per-channel subscriptions, and
 * checking what arrives against the contract it claims to be on.
 */
describe("push over the HTTP transport", () => {
  it("opens one stream however many screens are listening", async () => {
    arriveWithToken("a-token");
    const streams = stubPushStream();

    bridge().subscribe("items:changed", () => {});
    bridge().subscribe("config:changed", () => {});
    bridge().subscribeRefetch(() => {});

    await vi.waitFor(() => expect(streams).toHaveLength(1));
  });

  it("delivers a push to the channel's subscribers and to nobody else", async () => {
    arriveWithToken("a-token");
    const streams = stubPushStream();
    const items = vi.fn();
    const config = vi.fn();
    bridge().subscribe("items:changed", items);
    bridge().subscribe("config:changed", config);
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    streams[0]?.send('event: push:items:changed\ndata: {"itemId":"01a0"}\n\n');

    await vi.waitFor(() => expect(items).toHaveBeenCalledWith({ itemId: "01a0" }));
    expect(config).not.toHaveBeenCalled();
  });

  it("stops delivering to a subscriber that has gone", async () => {
    arriveWithToken("a-token");
    const streams = stubPushStream();
    const heard = vi.fn();
    const unsubscribe = bridge().subscribe("items:changed", heard);
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    unsubscribe();
    streams[0]?.send("event: push:items:changed\ndata: {}\n\n");
    // A second push, so there is something to wait *for* rather than a
    // sleep to prove a negative with.
    bridge().subscribe("config:changed", () => {});
    const other = vi.fn();
    bridge().subscribe("config:changed", other);
    streams[0]?.send("event: push:config:changed\ndata: {}\n\n");

    await vi.waitFor(() => expect(other).toHaveBeenCalled());
    expect(heard).not.toHaveBeenCalled();
  });

  it("ignores a push on a channel this bundle has never heard of", async () => {
    arriveWithToken("a-token");
    const streams = stubPushStream();
    const heard = vi.fn();
    bridge().subscribe("items:changed", heard);
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    // A tab left open across a server upgrade is the ordinary case, not
    // an exotic one, and a channel invented after this bundle was built
    // is what it meets.
    streams[0]?.send("event: push:invented:later\ndata: {}\n\n");
    streams[0]?.send("event: push:items:changed\ndata: {}\n\n");

    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
  });

  it("drops a push whose payload is not what its channel promised", async () => {
    arriveWithToken("a-token");
    const streams = stubPushStream();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const heard = vi.fn();
    bridge().subscribe("runs:changed", heard);
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    // `runs:changed` promises a runId, an itemId and a status. A screen
    // handed this would destructure `undefined`, which is a blank panel
    // rather than a missed update.
    streams[0]?.send('event: push:runs:changed\ndata: {"runId":"r"}\n\n');
    streams[0]?.send('event: push:runs:changed\ndata: {"runId":"r","itemId":"i","status":"running"}\n\n');

    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    expect(heard).toHaveBeenCalledWith({ runId: "r", itemId: "i", status: "running" });
    expect(warned).toHaveBeenCalled();
  });

  it("delivers an assistant chat's delta, messages and all, and drops one missing its number (EO-553)", async () => {
    arriveWithToken("a-token");
    const streams = stubPushStream();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const heard = vi.fn();
    bridge().subscribe("assist:delta", heard);
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    const message = {
      id: "m-1",
      authorType: "agent",
      authorName: "Assistant",
      body: "Two items wait on the Apollo board.",
      attachments: [],
      kind: "note",
      parentId: null,
      runId: null,
      options: null,
      canAnswer: false,
      createdAt: 1,
      canApprove: false,
      approves: null,
      moduleSlug: null,
      proposedType: null,
      status: null,
    };
    streams[0]?.send(`event: push:assist:delta\ndata: ${JSON.stringify({ conversationId: "c", messages: [message], messageIds: ["m-1"], earlier: 0, resync: false })}\n\n`);
    streams[0]?.send(`event: push:assist:delta\ndata: ${JSON.stringify({ conversationId: "c", seq: 1, messages: [message], messageIds: ["m-1"], earlier: 0, resync: false })}\n\n`);

    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    expect(heard).toHaveBeenCalledWith({ conversationId: "c", seq: 1, messages: [message], messageIds: ["m-1"], earlier: 0, resync: false });
    expect(warned).toHaveBeenCalled();
  });

  it("passes a reconnection's refetch on to whoever asked for one", async () => {
    arriveWithToken("a-token");
    const streams = stubPushStream();
    const refetch = vi.fn();
    const items = vi.fn();
    bridge().subscribeRefetch(refetch);
    bridge().subscribe("items:changed", items);
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    streams[0]?.send("event: refetch\ndata: {}\n\n");

    await vi.waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    // Not as a push: it is the connection speaking, not a channel.
    expect(items).not.toHaveBeenCalled();
  });

  it("has nothing to say about reconnection under Electron", () => {
    // The preload is part of the process it talks to: if main is gone,
    // so is this window. A disposer rather than nothing, because every
    // caller is a `useEffect` cleanup.
    const unsubscribe = bridge().subscribeRefetch(() => {
      throw new Error("a preload does not reconnect");
    });

    expect(() => unsubscribe()).not.toThrow();
  });
});

/**
 * That every screen goes through this module (EO-319).
 *
 * The same shape as `platform/electronConfinement.test.ts` in the main
 * process, and for the same reason: a single `window.eo` left anywhere
 * else is a screen that works on a desktop, throws in a browser, and
 * passes every test in this suite — because setupTests.ts defines
 * `window.eo` for all of them.
 */
describe("architectural invariant: the preload is reached through one file", () => {
  it("is named by the transport and by nothing else", () => {
    const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

    const offenders = sourceFiles(rendererRoot)
      .filter((file) => /\bwindow\.eo\b/.test(readFileSync(file, "utf8")))
      .map((file) => relative(rendererRoot, file))
      .filter((file) => file !== join("ipc", "bridge.ts"));

    expect(offenders).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    // Test files and setupTests.ts are excluded: a test *is* the preload
    // for the renderer it renders, and forbidding it there would only
    // push the same fake somewhere less obvious.
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== "setupTests.ts") files.push(full);
  }
  return files;
}

/** A page with no preload in front of it: a browser, served by a server. */
function withoutPreload(): void {
  setBridge(undefined);
  forgetPreload();
}

function forgetPreload(): void {
  // @ts-expect-error — `window.eo` is declared for the Electron case; its
  // absence is exactly what this describes.
  delete window.eo;
}

/**
 * …and arriving on an invitation link instead (EO-323).
 *
 * `/invite/<code>` and no query string, which is exactly what
 * `people:invite` answers with and what an admin pastes into their own
 * mail. Nobody following one has a token.
 */
function arriveOnAnInviteLink(): void {
  withoutPreload();
  vi.stubGlobal("location", { href: "http://eo.example/invite/a-one-time-code" });
  vi.stubGlobal("history", { replaceState: vi.fn() });
}

/** …and arriving at the address the server printed, token and all. */
function arriveWithToken(token: string): void {
  withoutPreload();
  vi.stubGlobal("location", { href: `http://eo.example/items?token=${token}` });
  vi.stubGlobal("history", { replaceState: vi.fn() });
}

function stubFetch(body: unknown = {}, status = 200) {
  const fetched = vi.fn().mockResolvedValue({ status, json: () => Promise.resolve(body) });
  vi.stubGlobal("fetch", fetched);
  return fetched;
}

/**
 * A `fetch` that answers the push stream with a stream this test drives.
 *
 * The real one on both sides — `openPushStream` is not mocked here, so
 * what these cases exercise is the parser as well as the fan-out.
 */
function stubPushStream(): { send(text: string): void }[] {
  const streams: { send(text: string): void }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(given) {
          controller = given;
        },
      });
      streams.push({ send: (text) => controller?.enqueue(new TextEncoder().encode(text)) });
      return Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
    }),
  );
  return streams;
}
