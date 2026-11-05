import { afterEach, describe, expect, it, vi } from "vitest";
import { PUSH_STREAM_PATH, PUSH_STREAM_READY_EVENT, PUSH_STREAM_REFETCH_EVENT } from "@eo/core";
import { openPushStream, type PushStreamHandle } from "./pushStream";

/**
 * The browser end of push (EO-321).
 *
 * The server end is proved against a real socket in
 * `main/server/pushStream.test.ts`, and the two ends are put together
 * with two whole browsers and two boards in `servedClients.test.tsx`.
 * This is this end on its own: the frames it can be handed, and the two
 * things it has to do that a preload never does — come back after the
 * connection went away, and say so when it does.
 */
let open: PushStreamHandle | null = null;

afterEach(() => {
  open?.close();
  open = null;
  vi.unstubAllGlobals();
});

interface Connection {
  init: RequestInit;
  send(text: string): void;
  end(): void;
}

/**
 * Every connection the client makes, with a stream this test drives.
 *
 * A list rather than one, because the interesting behaviour is what the
 * *second* request carries.
 */
function stubStream(status = 200): Connection[] {
  const connections: Connection[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(given) {
          controller = given;
        },
      });
      connections.push({
        init,
        send: (text) => controller?.enqueue(new TextEncoder().encode(text)),
        end: () => controller?.close(),
      });
      return Promise.resolve({ ok: status < 400, status, body } as unknown as Response);
    }),
  );
  return connections;
}

function frame(event: string, data: unknown, id?: number): string {
  return `${id === undefined ? "" : `id: ${String(id)}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** What the client would be given if it opened successfully. */
function listen(overrides: Partial<Parameters<typeof openPushStream>[0]> = {}) {
  const delivered: { wireChannel: string; payload: unknown }[] = [];
  const refetched = vi.fn();
  const unauthorized = vi.fn();
  open = openPushStream({
    token: () => "a-token",
    deliver: (wireChannel, payload) => delivered.push({ wireChannel, payload }),
    refetch: refetched,
    unauthorized,
    ...overrides,
  });
  return { delivered, refetched, unauthorized };
}

describe("reading a stream of pushes", () => {
  it("asks its own origin for the stream, with the token as a bearer", async () => {
    const connections = stubStream();
    listen();

    await vi.waitFor(() => expect(connections).toHaveLength(1));

    expect(fetch).toHaveBeenCalledWith(PUSH_STREAM_PATH, expect.objectContaining({ method: "GET" }));
    // A header, which is the whole reason this is `fetch` and not
    // `EventSource`: the token never reaches a request line, so it never
    // reaches a proxy log.
    expect(connections[0]?.init.headers).toMatchObject({ authorization: "Bearer a-token", accept: "text/event-stream" });
    expect(connections[0]?.init.headers).not.toHaveProperty("last-event-id");
  });

  it("delivers a push by the wire channel it arrived on", async () => {
    const connections = stubStream();
    const { delivered } = listen();
    await vi.waitFor(() => expect(connections).toHaveLength(1));

    connections[0]?.send(frame("push:items:changed", { itemId: "01a0" }, 1));

    await vi.waitFor(() => expect(delivered).toEqual([{ wireChannel: "push:items:changed", payload: { itemId: "01a0" } }]));
  });

  it("puts a frame back together however the chunks fell", async () => {
    const connections = stubStream();
    const { delivered } = listen();
    await vi.waitFor(() => expect(connections).toHaveLength(1));

    // A socket splits where it likes, and mid-frame is where it hurts:
    // a parser that assumed one chunk was one frame would deliver
    // nothing here and never say so.
    const whole = frame("push:config:changed", {}, 1) + frame("push:items:changed", { itemId: "x" }, 2);
    connections[0]?.send(whole.slice(0, 12));
    connections[0]?.send(whole.slice(12, 40));
    connections[0]?.send(whole.slice(40));

    await vi.waitFor(() =>
      expect(delivered).toEqual([
        { wireChannel: "push:config:changed", payload: {} },
        { wireChannel: "push:items:changed", payload: { itemId: "x" } },
      ]),
    );
  });

  it("ignores the heartbeat and the stream's own opening", async () => {
    const connections = stubStream();
    const { delivered, refetched } = listen();
    await vi.waitFor(() => expect(connections).toHaveLength(1));

    connections[0]?.send(": keep-alive\n\n");
    connections[0]?.send(`retry: 2000\n\n`);
    connections[0]?.send(frame(PUSH_STREAM_READY_EVENT, {}, 4));
    connections[0]?.send(frame("push:items:changed", {}, 5));

    // The one real push arrives and the three pieces of housekeeping do
    // not — a `ready` delivered as a channel would reach a screen that
    // has no idea what it is.
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]?.wireChannel).toBe("push:items:changed");
    expect(refetched).not.toHaveBeenCalled();
  });

  it("drops a frame it cannot read rather than ending the stream on it", async () => {
    const connections = stubStream();
    const { delivered } = listen();
    await vi.waitFor(() => expect(connections).toHaveLength(1));

    connections[0]?.send("event: push:items:changed\ndata: {not json\n\n");
    connections[0]?.send(frame("push:items:changed", { itemId: "after" }, 2));

    // The stream survived it, which is the point: one malformed push
    // must not take the connection every other push arrives on.
    await vi.waitFor(() => expect(delivered).toEqual([{ wireChannel: "push:items:changed", payload: { itemId: "after" } }]));
  });
});

describe("a connection that went away", () => {
  it("comes back presenting the last id it was sent, and passes on the refetch", async () => {
    const connections = stubStream();
    const { refetched, delivered } = listen();
    await vi.waitFor(() => expect(connections).toHaveLength(1));

    // Connected, told nothing, and dropped — which is the case the
    // server's opening `ready` exists for. Without an id from it this
    // client would come back looking like a new one and never be told
    // what it missed.
    connections[0]?.send(frame(PUSH_STREAM_READY_EVENT, {}, 9));
    await vi.waitFor(() => expect(connections[0]).toBeDefined());
    connections[0]?.end();

    await vi.waitFor(() => expect(connections).toHaveLength(2), { timeout: 5000 });
    expect(connections[1]?.init.headers).toMatchObject({ "last-event-id": "9" });

    connections[1]?.send(frame(PUSH_STREAM_REFETCH_EVENT, {}, 9));

    await vi.waitFor(() => expect(refetched).toHaveBeenCalledTimes(1));
    // Not delivered as a channel: nothing subscribes to it, and a screen
    // asked to invalidate one key would be the wrong answer anyway.
    expect(delivered).toEqual([]);
  });

  it("forgets a token the server has stopped accepting", async () => {
    stubStream(401);
    const { unauthorized } = listen();

    await vi.waitFor(() => expect(unauthorized).toHaveBeenCalled());
  });

  it("stops trying once it is closed", async () => {
    const connections = stubStream();
    listen();
    await vi.waitFor(() => expect(connections).toHaveLength(1));

    open?.close();
    open = null;
    connections[0]?.end();

    // Long enough for the first backoff to have fired twice over. A
    // closed stream that kept reconnecting would be a page that has been
    // navigated away from still holding a socket.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(connections).toHaveLength(1);
  });

  it("waits longer each time nothing is there, rather than spinning", async () => {
    // No token means no request at all, which is the cheapest way to
    // make every attempt fail — and counting the attempts is the point.
    // A loop with no backoff in it would run this thousands of times in
    // the same second and take a tab's main thread with it.
    const connections = stubStream();
    let attempts = 0;
    listen({
      token: () => {
        attempts += 1;
        return null;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(connections).toHaveLength(0);
    // 500ms, then 1000ms: three tries fit in 1200ms and a fourth does not.
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(4);
  });
});
