import type { IncomingMessage, ServerResponse } from "node:http";
import { PUSH_STREAM_READY_EVENT, PUSH_STREAM_REFETCH_EVENT } from "@eo/core";
import type { PushTransport } from "../ipc/push.js";

/**
 * Push over a transport that is not `webContents` (EO-321,
 * `ARCHITECTURE.md`, "The server").
 *
 * The second implementation of the interface KAN-127 defined. The
 * desktop's is a window: one renderer, in this process, reached by a
 * method call that cannot fail slowly. This one is a socket, or several
 * — every browser with the app open — and everything below is the
 * difference between those two facts.
 *
 * Server-sent events rather than a WebSocket, and that is a decision
 * rather than a default. Push is one-directional: the requests already
 * go the other way over `/ipc/…`, and nothing a renderer wants to say
 * needs a second channel to say it on. SSE is a GET that never ends, so
 * it needs no second protocol, no upgrade handshake and no framing of
 * its own; it reconnects on its own terms, and this file is the half of
 * that which decides what a reconnecting client is told.
 *
 * ### The two things that go wrong with a socket and not with a window
 *
 * **A client that goes away.** A reconnecting one must not be replayed
 * to, because a replay means a log and a log means deciding how long to
 * keep it. It is answered with one `refetch` instead — see
 * `PUSH_STREAM_REFETCH_EVENT` in core for why that is equivalent.
 *
 * **A client that cannot keep up.** `response.write` returning false
 * means the kernel buffer is full and Node is holding the rest in
 * memory — unboundedly, which is how a laptop that went to sleep with a
 * tab open becomes this process's memory problem. So a client that is
 * behind is written nothing more until it drains, and what it has
 * missed is collapsed into the same single `refetch`. Coalescing is
 * free here for the reason a replay is unnecessary: these are
 * invalidations, and one of them says as much as forty.
 */
export interface PushStream extends PushTransport {
  /**
   * Takes over a request that has already been authenticated and turns
   * it into a stream (`server/http.ts`).
   *
   * The door checks the token; this never sees one. That split is the
   * same one `dispatch` has, and for the same reason: who may be here
   * is the door's question, and what they are sent is this file's.
   */
  attach(request: IncomingMessage, response: ServerResponse): void;
  /** How many clients are attached. For the log line, and for tests. */
  clientCount(): number;
  /** Ends every stream. Called when the server stops serving. */
  close(): void;
}

export interface PushStreamOptions {
  /**
   * How often a comment line is written down an idle stream.
   *
   * Not for the client, which is content to wait: for everything
   * between them. A proxy with an idle timeout closes a stream that has
   * said nothing for a minute, and this process would never learn that
   * it had — a half-open socket is written to happily and read by
   * nobody. The heartbeat is what turns that into an error this end can
   * see, and what keeps the intermediary from closing it in the first
   * place.
   */
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 25_000;

interface Client {
  response: ServerResponse;
  /** True while the socket has not drained — see the class comment. */
  behind: boolean;
  /** Something was dropped while behind, so a `refetch` is owed on drain. */
  owed: boolean;
}

export function createPushStream(options: PushStreamOptions = {}): PushStream {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const clients = new Set<Client>();
  let heartbeat: NodeJS.Timeout | null = null;

  /**
   * How far a client has got.
   *
   * Monotonic within one run of this process and meaningless outside it
   * — nothing is kept to replay from, so the only question it is ever
   * asked is "have you been here before", which any changing number
   * answers. A restarted server starts again at one, and a client
   * holding an id from the process before is still recognised as
   * returning, which is the honest answer: it missed everything.
   */
  let lastId = 0;

  const frame = (event: string, data: unknown, id: number): string =>
    `id: ${String(id)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  /**
   * Writes to one client, or remembers that it could not.
   *
   * The `behind` branch is the backpressure policy in three lines: once
   * a socket has stopped accepting, nothing further is queued behind it
   * — the frames are dropped and the debt recorded, to be paid with one
   * `refetch` when it drains.
   */
  const write = (client: Client, text: string): void => {
    if (client.behind) {
      client.owed = true;
      return;
    }
    if (!client.response.write(text)) client.behind = true;
  };

  const drained = (client: Client): void => {
    client.behind = false;
    if (!client.owed) return;
    client.owed = false;
    write(client, frame(PUSH_STREAM_REFETCH_EVENT, {}, lastId));
  };

  const startHeartbeat = (): void => {
    if (heartbeat !== null) return;
    heartbeat = setInterval(() => {
      // A comment line: it is not an event, so it moves no client's id
      // and wakes no listener. All it does is put a byte on the wire —
      // and tell this end whether the wire is still taking them, which
      // is why a heartbeat that does not flush marks the client behind
      // without putting it in debt. There is nothing to catch up on: a
      // heartbeat says nothing.
      for (const client of clients) {
        if (client.behind) continue;
        if (!client.response.write(": keep-alive\n\n")) client.behind = true;
      }
    }, heartbeatMs);
    // So a stream never becomes the reason this process will not exit.
    heartbeat.unref();
  };

  const stopHeartbeatIfIdle = (): void => {
    if (clients.size > 0 || heartbeat === null) return;
    clearInterval(heartbeat);
    heartbeat = null;
  };

  return {
    send(wireChannel, payload) {
      lastId += 1;
      const text = frame(wireChannel, payload, lastId);
      for (const client of clients) write(client, text);
    },

    attach(request, response) {
      // A stream is not a request with a long body: the connection is
      // the point of it, and the defaults that protect a short request
      // are what would close this one. `setTimeout(0)` is Node's own way
      // of saying "this socket has no idle limit", and Nagle's algorithm
      // would sit on a 40-byte invalidation waiting for company.
      request.socket.setNoDelay(true);
      request.socket.setTimeout(0);

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        // For the reverse proxies that buffer a response until it ends —
        // which, for a response that never ends, means delivering
        // nothing at all while appearing to work.
        "x-accel-buffering": "no",
      });
      response.flushHeaders();

      const client: Client = { response, behind: false, owed: false };
      clients.add(client);
      response.on("drain", () => drained(client));
      const leave = (): void => {
        clients.delete(client);
        stopHeartbeatIfIdle();
      };
      response.on("close", leave);
      response.on("error", leave);

      // The client's own retry floor, for a browser using native
      // `EventSource`. EO's renderer backs off on its own schedule and
      // ignores this; it costs one line to be correct for anything else.
      response.write(`retry: 2000\n\n`);

      // Both openings carry an id, so that a client which has connected
      // once is recognisable when it comes back even if nothing was ever
      // pushed to it. Which of the two it gets is the whole of the
      // reconnection contract: a client that presents a `Last-Event-ID`
      // has been here before and may have missed something, and is told
      // to ask for everything again rather than replayed to.
      const returning = typeof request.headers["last-event-id"] === "string";
      write(client, frame(returning ? PUSH_STREAM_REFETCH_EVENT : PUSH_STREAM_READY_EVENT, {}, lastId));

      startHeartbeat();
    },

    clientCount: () => clients.size,

    close() {
      for (const client of clients) client.response.end();
      clients.clear();
      stopHeartbeatIfIdle();
    },
  };
}
