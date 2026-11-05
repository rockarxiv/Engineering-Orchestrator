import { afterEach, describe, expect, it, vi } from "vitest";
import { PUSH_STREAM_PATH, PUSH_STREAM_READY_EVENT, PUSH_STREAM_REFETCH_EVENT, pushWireChannel } from "@eo/core";
import { createPushClient, type PushClient } from "./pushClient.js";

/**
 * A desktop listening to its organisation's record (EO-324,
 * `ARCHITECTURE.md`, "The record").
 *
 * What is asserted here is the *client*: which frames make it go and
 * ask, which are noise, and what it does when the stream ends. That a
 * push and a sync add up to a colleague's move appearing on another
 * board is `sync.test.ts`'s, and that the server writes these frames at
 * all is `server/pushStream.test.ts`'s.
 *
 * The stream is a string and a fake `fetch`, which is the whole of what
 * this end sees: bytes arriving in whatever chunks the network chose.
 * Several tests deliberately split a frame across chunks, because a
 * parser that only ever sees whole frames is a parser that has not been
 * tested.
 */

const SESSION = { address: "https://eo.example.com", token: "a-device-token" };

let client: PushClient | null = null;

afterEach(() => {
  client?.stop();
  client = null;
});

/** One frame, as `server/pushStream.ts` writes them. */
function frame(event: string, data: unknown, id: number): string {
  return `id: ${String(id)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A record that sends these chunks and then ends the stream.
 *
 * Answers the requests it was given, so a test can assert on the
 * headers — which is where the token and `Last-Event-ID` are, and both
 * of those are the point of this client having been written by hand.
 */
function recordSending(...responses: string[][]): { fetch: typeof globalThis.fetch; requests: Request[] } {
  const requests: Request[] = [];
  let attempt = 0;
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(typeof input === "string" ? input : String(input), init));
    const chunks = responses[Math.min(attempt, responses.length - 1)] ?? [];
    attempt += 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  return { fetch: impl as unknown as typeof globalThis.fetch, requests };
}

/** Waits for something the loop does on its own schedule, or gives up loudly. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("a desktop subscribed to its record", () => {
  it("asks the record for what changed, once per push", async () => {
    let synced = 0;
    const record = recordSending([
      frame(PUSH_STREAM_READY_EVENT, {}, 1),
      frame(pushWireChannel("items:changed"), { itemId: "t1" }, 2),
      frame(pushWireChannel("runs:changed"), { runId: "r1" }, 3),
    ]);

    client = createPushClient({
      session: () => SESSION,
      onChanged: async () => {
        synced += 1;
      },
      fetch: record.fetch,
      firstRetryMs: 5,
      maxRetryMs: 5,
    });

    // Two pushes, two syncs. `ready` is not one of them: it says the
    // stream is open, which is not news about the record.
    await until(() => synced >= 2, "two syncs");
    expect(synced).toBe(2);
  });

  it("carries the device token, and never puts it in the address", async () => {
    const record = recordSending([frame(PUSH_STREAM_READY_EVENT, {}, 1)]);
    client = createPushClient({ session: () => SESSION, onChanged: async () => {}, fetch: record.fetch, firstRetryMs: 5, maxRetryMs: 5 });

    await until(() => record.requests.length > 0, "a request");

    const asked = record.requests[0]!;
    expect(asked.url).toBe(`${SESSION.address}${PUSH_STREAM_PATH}`);
    expect(asked.headers.get("authorization")).toBe(`Bearer ${SESSION.token}`);
    // The one place this app has decided not to put a token: a device
    // token in a URL is a device token in every proxy log between here
    // and the server.
    expect(asked.url).not.toContain(SESSION.token);
  });

  it("reads a frame that arrived in pieces", async () => {
    let synced = 0;
    // A chunk off a socket ends wherever the network decided, which is
    // rarely on a frame boundary.
    const record = recordSending(["id: 1\nev", "ent: push:items:chan", 'ged\ndata: {"item', 'Id":"t1"}\n\n']);
    client = createPushClient({
      session: () => SESSION,
      onChanged: async () => {
        synced += 1;
      },
      fetch: record.fetch,
      firstRetryMs: 5,
      maxRetryMs: 5,
    });

    await until(() => synced >= 1, "a sync");
  });

  it("ignores the heartbeat, which is a comment and says nothing", async () => {
    let synced = 0;
    const record = recordSending([": keep-alive\n\n", ": keep-alive\n\n"]);
    client = createPushClient({
      session: () => SESSION,
      onChanged: async () => {
        synced += 1;
      },
      fetch: record.fetch,
      firstRetryMs: 5,
      maxRetryMs: 5,
    });

    await until(() => record.requests.length >= 2, "a reconnection");
    expect(synced).toBe(0);
  });

  it("comes back, and says where it had got to so the record can tell it to ask again", async () => {
    let synced = 0;
    const record = recordSending(
      [frame(pushWireChannel("items:changed"), {}, 7)],
      [frame(PUSH_STREAM_REFETCH_EVENT, {}, 8)],
    );
    client = createPushClient({
      session: () => SESSION,
      onChanged: async () => {
        synced += 1;
      },
      fetch: record.fetch,
      firstRetryMs: 5,
      maxRetryMs: 5,
    });

    await until(() => record.requests.length >= 2, "a reconnection");

    // The second request says where this device had got to. It is not a
    // cursor — nothing is replayed from it — it is how the record tells
    // a client coming back from one arriving new, and answers the first
    // with `refetch`.
    expect(record.requests[0]!.headers.get("last-event-id")).toBeNull();
    expect(record.requests[1]!.headers.get("last-event-id")).toBe("7");
    // And a `refetch` *is* news: things happened while this device was
    // away.
    await until(() => synced >= 2, "a sync for the refetch");
  });

  it("stops presenting a token the record has stopped accepting", async () => {
    let signedOut = 0;
    const impl = vi.fn(async () => new Response(null, { status: 401 }));
    client = createPushClient({
      session: () => SESSION,
      onChanged: async () => {},
      onSignedOut: () => {
        signedOut += 1;
      },
      fetch: impl as unknown as typeof globalThis.fetch,
      firstRetryMs: 5,
      maxRetryMs: 5,
    });

    await until(() => signedOut >= 1, "the signing-out");
  });

  it("waits rather than gives up when this desktop is signed in to nothing", async () => {
    const record = recordSending([frame(PUSH_STREAM_READY_EVENT, {}, 1)]);
    let signedIn = false;
    client = createPushClient({
      // A solo desktop, and then somebody signs in without relaunching.
      session: () => (signedIn ? SESSION : null),
      onChanged: async () => {},
      fetch: record.fetch,
      firstRetryMs: 5,
      maxRetryMs: 5,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(record.requests).toHaveLength(0);

    signedIn = true;
    await until(() => record.requests.length > 0, "a request once signed in");
  });

  it("refuses to carry a device token over plain HTTP to somewhere that is not this machine", async () => {
    const record = recordSending([frame(PUSH_STREAM_READY_EVENT, {}, 1)]);
    client = createPushClient({
      session: () => ({ address: "http://eo.example.com", token: "a-device-token" }),
      onChanged: async () => {},
      fetch: record.fetch,
      firstRetryMs: 5,
      maxRetryMs: 5,
    });

    // Refused before a socket is opened, exactly as the request client
    // refuses it: "we noticed afterwards that it went in the clear" is
    // not a thing worth being able to say.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(record.requests).toHaveLength(0);
  });

  it("stops asking once it is stopped", async () => {
    const record = recordSending([frame(PUSH_STREAM_READY_EVENT, {}, 1)]);
    const running = createPushClient({ session: () => SESSION, onChanged: async () => {}, fetch: record.fetch, firstRetryMs: 5, maxRetryMs: 5 });

    await until(() => record.requests.length > 0, "a request");
    running.stop();
    const made = record.requests.length;

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(record.requests.length).toBe(made);
  });
});
