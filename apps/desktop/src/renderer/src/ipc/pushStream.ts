import { parsePushFrame, PUSH_STREAM_PATH, PUSH_STREAM_READY_EVENT, PUSH_STREAM_REFETCH_EVENT, readPushFrames } from "@eo/core";

/**
 * The browser end of push, for a renderer served from a server
 * (EO-321, `ARCHITECTURE.md`, "The server").
 *
 * Under Electron the preload has already put `ipcRenderer` in front of
 * this renderer and pushes arrive as events on a channel. Served over
 * HTTP there is no preload and no channel, so the same pushes come down
 * one long-lived GET as server-sent events. This file is the client for
 * that: it holds the connection, parses the frames, and puts them back
 * together into "this wire channel said this". What the channels *mean*
 * is `bridge.ts`'s, which is why nothing here names one.
 *
 * ### Why `fetch` and not `EventSource`
 *
 * `EventSource` is the browser's own SSE client and it would do all of
 * the above for free, except for one thing: it cannot send a header.
 * The token would have to go in the query string, which is the one
 * place this app has decided not to put it — `bridge.ts` takes it out
 * of the URL on arrival precisely so that it is not in an address bar
 * to be copied, and a server that logged its own request lines would
 * keep a copy of it on every reconnection for ever.
 *
 * So: `fetch` with an `Authorization` header and a reader over the
 * response body. Which costs a parser and a reconnection loop, and buys
 * back the thing the loop has to do anyway — see `Last-Event-ID` below,
 * where reconnecting is not "carry on from here" but "tell me to ask
 * again".
 */
export interface PushStreamOptions {
  /**
   * The admin token, read per attempt rather than captured.
   *
   * A reconnection is a new request, and the token it should carry is
   * whatever the tab holds *now* — which a 401 on the previous attempt
   * may have cleared.
   */
  token: () => string | null;
  /** One push, by the wire channel it arrived on. */
  deliver: (wireChannel: string, payload: unknown) => void;
  /** "Ask for everything again" — see `PUSH_STREAM_REFETCH_EVENT`. */
  refetch: () => void;
  /** The server did not accept the token. `bridge.ts` forgets it. */
  unauthorized?: () => void;
}

export interface PushStreamHandle {
  /** Drops the connection and stops reconnecting. */
  close(): void;
}

/** The first backoff, and the ceiling it doubles towards. */
const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 15_000;

/**
 * Opens the stream and keeps it open, for as long as the page lives.
 *
 * Returns immediately: the connection is made in the background and
 * remade whenever it ends, because the interesting case is not the
 * first connection but the ten-thousandth — a laptop that slept, a wifi
 * that moved, a server that restarted. None of those are errors a
 * screen should see, which is why nothing here rejects and nothing here
 * throws.
 */
export function openPushStream(options: PushStreamOptions): PushStreamHandle {
  let closed = false;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The last id the server sent, and the whole of what this end
   * remembers between connections.
   *
   * It is not a cursor: nothing is replayed from it. It is presented as
   * `Last-Event-ID` so that the server can tell a client coming back
   * from one arriving for the first time, and answer the first with a
   * `refetch`. Which is why the server opens every stream with an id
   * even when it has pushed nothing — otherwise a client that connected
   * quietly and then dropped would come back looking new.
   */
  let lastEventId: string | null = null;

  const run = async (): Promise<void> => {
    let attempt = 0;

    while (!closed) {
      const delivered = await connect();
      if (closed) return;

      // A connection that delivered something was a working connection,
      // however briefly. Resetting on that rather than on "the request
      // returned 200" is what stops a server that accepts and
      // immediately drops from being retried in a tight loop.
      attempt = delivered ? 1 : attempt + 1;
      await pause(Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (attempt - 1)));
    }
  };

  /** One attempt. Resolves when the stream ends, however it ends. */
  const connect = async (): Promise<boolean> => {
    const token = options.token();
    if (token === null) return false;

    controller = new AbortController();
    try {
      const response = await fetch(PUSH_STREAM_PATH, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${token}`,
          ...(lastEventId === null ? {} : { "last-event-id": lastEventId }),
        },
        signal: controller.signal,
        cache: "no-store",
      });

      if (response.status === 401) {
        // The same treatment `invoke` gives it: a token that has stopped
        // working is forgotten rather than resent on every reconnection
        // for the rest of the session.
        options.unauthorized?.();
        return false;
      }
      if (!response.ok || !response.body) return false;

      return await read(response.body);
    } catch {
      // Every way a socket ends badly arrives here — refused, reset,
      // aborted by `close()` — and all of them mean the same thing to
      // this loop: there is no stream, try again in a moment.
      return false;
    }
  };

  const read = async (body: ReadableStream<Uint8Array>): Promise<boolean> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let delivered = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) return delivered;
      buffer += decoder.decode(value, { stream: true });

      // Framing is the push contract's own, shared with the main
      // process's client (`@eo/core/pushFrames`): two readings of one
      // format is two sets of frames one end drops and the other does
      // not.
      const read = readPushFrames(buffer);
      buffer = read.rest;
      for (const frame of read.frames) {
        dispatch(frame);
        delivered = true;
      }
      if (closed) return delivered;
    }
  };

  /** One frame, as the push contract spells it — see `parsePushFrame`. */
  const dispatch = (frame: string): void => {
    const { event, id, data } = parsePushFrame(frame);
    if (id !== null) lastEventId = id;
    if (data === null) return;

    // Both of the stream's own events carry nothing but the id this
    // loop has already taken off them above. One says "you are
    // connected", the other says "you were connected, and things
    // happened while you were not".
    if (event === PUSH_STREAM_READY_EVENT) return;
    if (event === PUSH_STREAM_REFETCH_EVENT) {
      options.refetch();
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      // A frame this end cannot read is dropped rather than thrown
      // through the reader: one malformed push must not end the stream
      // that the rest of them arrive on.
      return;
    }
    options.deliver(event, payload);
  };

  /**
   * Waits, interruptibly.
   *
   * `close()` resolves it rather than only cancelling the timer, so the
   * loop above gets one more turn, sees `closed` and returns. A
   * cancelled timer with nothing to resolve it would leave that loop
   * suspended for the life of the page, holding everything it closes
   * over.
   */
  let wake: (() => void) | null = null;
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve;
      retryTimer = setTimeout(resolve, ms);
    });

  void run();

  return {
    close() {
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      wake?.();
      wake = null;
      controller?.abort();
      controller = null;
    },
  };
}
