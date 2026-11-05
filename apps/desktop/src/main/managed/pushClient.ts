import {
  normalizeServerAddress,
  parsePushFrame,
  PUSH_STREAM_PATH,
  PUSH_STREAM_READY_EVENT,
  readPushFrames,
  serverAddressRefusal,
} from "@eo/core";

/**
 * A desktop listening to its organisation's record (EO-324,
 * `ARCHITECTURE.md`, "The record", "The server").
 *
 * The inbound half of managed mode, and until it existed the phase had
 * a hole in exactly the place its first acceptance criterion points at:
 * *"a move on one appears on the other"*. Everything a device does
 * reaches the record within a tick; everything the record has reaches a
 * device when that device next thinks to ask. So Dana moved a card and
 * Anna's board showed the old column until her supervisor's five-second
 * tick came round — which is not "appears on the other", it is "appears
 * on the other eventually, and you cannot tell whether it has".
 *
 * `server/pushStream.ts` has been emitting the invalidations all along.
 * The only client was a browser served by the server itself
 * (`renderer/src/ipc/pushStream.ts`); an Electron desktop signed in to
 * a *remote* record subscribed to nothing. This is that subscriber, in
 * the main process, where the record and the replica are.
 *
 * ### What it does with a push, and what it does not
 *
 * A push carries no data — `ipcPushContract`'s own rule is that it says
 * "this changed, ask again" and never what changed. So this file reads
 * frames and calls one function: *go and sync*. The asking is
 * `drain.ts`'s, and it is the same asking the tick does, which is what
 * keeps a pushed change and a polled one from being two code paths that
 * could disagree.
 *
 * ### Why `fetch` and not `EventSource`
 *
 * The renderer's client gives the whole argument and it holds here with
 * one more reason on top: `EventSource` cannot send a header, the token
 * would have to go in the query string, and a device token in a URL is
 * a device token in every proxy log between here and the server. Node
 * has no `EventSource` worth relying on anyway.
 */

export interface PushClientOptions {
  /**
   * Where the record is, and the token to reach it with — read per
   * attempt rather than captured.
   *
   * A reconnection is a new request and should carry whatever this
   * machine holds *now*: a sign-in that happened while the loop was
   * backing off, or a token a revocation has since cleared. `null`
   * means this desktop is signed in to nothing, and the loop waits
   * rather than ends — somebody may sign in without relaunching.
   */
  session: () => { address: string; token: string } | null;
  /**
   * The record said something changed. Go and find out what.
   *
   * Every frame leads here, whatever channel it named, because a push
   * carries no data. Awaited, so that two pushes arriving together
   * become one sync after the other rather than two at once over the
   * same queue.
   */
  onChanged: () => Promise<unknown>;
  /** The record stopped accepting this machine's token. `session.markRevoked` is what production passes. */
  onSignedOut?: () => void;
  /** `globalThis.fetch` in production. A test passes its own rather than opening a socket. */
  fetch?: typeof globalThis.fetch;
  /** The first backoff, doubling to `maxRetryMs`. Short in a test; seconds in production. */
  firstRetryMs?: number;
  maxRetryMs?: number;
}

export interface PushClient {
  /** Drops the connection and stops reconnecting. */
  stop(): void;
  /** Whether a stream is open right now. For the tests, and for a log line. */
  connected(): boolean;
}

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * Opens the stream and keeps it open for the life of the process.
 *
 * Returns immediately. The interesting case is not the first connection
 * but the ten-thousandth — a laptop that slept, a wifi that moved, a
 * server that restarted — so nothing here rejects and nothing here
 * throws: a connection that ends is a connection to make again.
 */
export function createPushClient(options: PushClientOptions): PushClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const firstRetryMs = options.firstRetryMs ?? FIRST_RETRY_MS;
  const maxRetryMs = options.maxRetryMs ?? MAX_RETRY_MS;

  let stopped = false;
  let open = false;
  let controller: AbortController | null = null;

  /**
   * The last id the record sent, and all this end remembers between
   * connections.
   *
   * Not a cursor — nothing is replayed from it. It is presented as
   * `Last-Event-ID` so the record can tell a client coming back from
   * one arriving for the first time, and answer the first with a
   * `refetch` rather than a `ready`. The difference matters: a desktop
   * that dropped for two minutes has missed things and must ask; one
   * that has just started has nothing to catch up on beyond what its
   * first tick will do anyway.
   */
  let lastEventId: string | null = null;

  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // So a backoff is never the reason this process will not exit.
      timer.unref?.();
    });

  /** One attempt. Resolves when the stream ends, however it ends. */
  async function connect(): Promise<boolean> {
    const session = options.session();
    if (session === null) return false;
    const address = normalizeServerAddress(session.address);
    // The same rule the request client keeps, checked before a socket
    // is opened rather than after: this carries a device token, and
    // "we noticed afterwards that it went in the clear" is not a thing
    // worth being able to say.
    if (serverAddressRefusal(address) !== null) return false;

    controller = new AbortController();
    try {
      const response = await doFetch(`${address}${PUSH_STREAM_PATH}`, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${session.token}`,
          ...(lastEventId === null ? {} : { "last-event-id": lastEventId }),
        },
        signal: controller.signal,
      });

      if (response.status === 401) {
        // A token that has stopped working is reported once and not
        // presented again every second for the rest of the session.
        options.onSignedOut?.();
        return false;
      }
      if (!response.ok || response.body === null) return false;

      open = true;
      return await read(response.body);
    } catch {
      // Refused, reset, aborted by `stop()`, DNS gone with the wifi:
      // every way a socket ends badly arrives here and all of them mean
      // the same thing to this loop.
      return false;
    } finally {
      open = false;
    }
  }

  async function read(body: ReadableStream<Uint8Array>): Promise<boolean> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let delivered = false;

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return delivered;
      buffer += decoder.decode(chunk.value, { stream: true });
      const framed = readPushFrames(buffer);
      buffer = framed.rest;
      for (const frame of framed.frames) {
        delivered = true;
        await deliver(frame);
      }
      if (stopped) return delivered;
    }
  }

  /**
   * One frame, and the one thing this client does about any of them.
   *
   * `ready` is the only event that means nothing: it says the stream is
   * open, which the caller can see. Everything else — a named channel,
   * or the stream's own `refetch` — means the record has changed and
   * this device should go and look.
   *
   * Awaited rather than fired off, so a burst of pushes becomes one
   * sync after another over the same queue rather than several at once
   * over it. A sync that throws is swallowed here for the reason the
   * connection errors are: the next push, or the next tick, tries
   * again, and a stream that ended because a drain failed would turn a
   * transient database error into a desktop that stops hearing.
   */
  async function deliver(frame: string): Promise<void> {
    const { event, id, data } = parsePushFrame(frame);
    if (id !== null) lastEventId = id;
    // A heartbeat is a comment and carries no fields at all.
    if (data === null) return;
    if (event === PUSH_STREAM_READY_EVENT) return;
    try {
      await options.onChanged();
    } catch (error) {
      console.warn("[eo] syncing after a push from the record failed:", error);
    }
  }

  void (async () => {
    let attempt = 0;
    while (!stopped) {
      const delivered = await connect();
      if (stopped) return;
      // A connection that delivered something was a working connection,
      // however briefly. Resetting the backoff on that rather than on
      // "the request returned 200" is what stops a record that accepts
      // and immediately drops from being retried in a tight loop.
      attempt = delivered ? 1 : attempt + 1;
      await pause(Math.min(maxRetryMs, firstRetryMs * 2 ** (attempt - 1)));
    }
  })();

  return {
    stop() {
      stopped = true;
      controller?.abort();
    },
    connected: () => open,
  };
}
