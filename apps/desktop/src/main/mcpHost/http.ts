import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { tokenMatches } from "./token.js";
import type { McpProtocolHost } from "./server.js";

/**
 * The socket, and everything that has to be true before a request
 * reaches the protocol.
 *
 * Bound to 127.0.0.1 explicitly and never to 0.0.0.0. That is
 * load-bearing rather than decorative: it is the difference between a
 * server only this machine can reach and one the coffee-shop wifi can,
 * and on Windows it is also the difference between starting quietly and
 * raising a firewall prompt nobody asked for.
 */
export const MCP_PATH = "/mcp";

/** POST carries a request, GET opens the notification stream, DELETE ends a session. */
const METHODS = new Set(["POST", "GET", "DELETE"]);

/** A body larger than this is not an MCP call; it is something else, and reading it is the mistake. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface ListenerOptions {
  port: number;
  /**
   * The bearer this socket answers to, or — for a host that hands out
   * more than one — what decides whether a presented one is current
   * (EO-444). The admin host mints one per turn and lets each go when its
   * turn ends, so there is no single value to compare against.
   */
  token: string | ((presented: string) => boolean);
  host: McpProtocolHost;
}

export interface McpListener {
  port: number;
  close: () => Promise<void>;
}

export type ListenResult = { ok: true; listener: McpListener } | { ok: false; problem: string };

/** Whether the socket's far end is this machine. Belt to the bind's braces. */
function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  if (address === undefined) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * The names this server answers to, given the port it bound.
 *
 * A DNS name that resolves to 127.0.0.1 is how a web page reaches a
 * loopback server it was never meant to touch, so the Host header is
 * checked against a list built here rather than against whatever
 * happened to arrive.
 */
export function allowedNamesFor(port: number): { hosts: string[]; origins: string[] } {
  return {
    hosts: [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`],
    origins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
  };
}

function deny(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }));
}

/** The bearer a request carries, or null. Exported for the admin host, which tells its turns apart by it (EO-444). */
export function presentedToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

async function readBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; problem: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    // `Readable`'s async iterator yields `any`; narrowed rather than
    // asserted, so a string chunk from a future encoding change is
    // handled instead of silently mis-measured.
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      // Drained rather than returned from. Returning out of a `for await`
      // destroys the request stream, and the 400 written afterwards then
      // goes to a socket the runtime has already torn down — so the
      // caller sees ECONNRESET and never reads the reason.
      tooLarge = true;
      continue;
    }
    if (!tooLarge) chunks.push(buffer);
  }
  if (tooLarge) return { ok: false, problem: "Request body is too large." };
  if (size === 0) return { ok: true, value: undefined };

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, problem: "Request body is not valid JSON." };
  }
}

/**
 * A port nothing is using, released again before it is returned.
 *
 * Inherently a guess by the time the caller binds it — something else
 * could take it in between — but the alternative is a person reading
 * `netstat`. The race loses nothing: binding then reports the port as
 * busy, which is the same answer they would have got anyway.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export function startListener(options: ListenerOptions): Promise<ListenResult> {
  // Derived from the port actually bound, not the one asked for. They
  // differ whenever the caller passes 0 to mean "find me a free one",
  // which is exactly what Settings' "Pick a free port" does — and a
  // Host allowlist built from the wrong number rejects every request.
  let boundPort = options.port;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopback(req)) return deny(res, 403, "Not reachable from there.");

    // A wrong path gets an empty 404 — no banner, no version — because
    // the first thing anything scanning a loopback port does is ask what
    // is listening. This is not invisibility and should not be described
    // as it: /mcp with a valid Host and no credential still answers 401
    // with `www-authenticate: Bearer`, which is what a spec-compliant
    // server must do and is enough to identify it. What the silence buys
    // is that identifying it requires guessing the path first.
    const path = (req.url ?? "").split("?")[0];
    if (path !== MCP_PATH || !METHODS.has(req.method ?? "")) {
      res.writeHead(404).end();
      return;
    }

    const allowed = allowedNamesFor(boundPort);

    const host = req.headers.host;
    if (typeof host !== "string" || !allowed.hosts.includes(host)) {
      return deny(res, 403, "Invalid Host header.");
    }

    // Absent is fine — a non-browser client sends no Origin at all, and
    // that is the ordinary case here. Present and foreign is the attack.
    const origin = req.headers.origin;
    if (typeof origin === "string" && !allowed.origins.includes(origin)) {
      return deny(res, 403, "Invalid Origin header.");
    }

    const presented = presentedToken(req);
    const expected = options.token;
    const accepted = presented !== null && (typeof expected === "string" ? tokenMatches(expected, presented) : expected(presented));
    if (!accepted) {
      // No detail about which half was wrong, and the same answer for a
      // missing header as for a wrong token.
      return deny(res, 401, "Unauthorized.", { "www-authenticate": "Bearer" });
    }

    const body = req.method === "POST" ? await readBody(req) : ({ ok: true, value: undefined } as const);
    if (!body.ok) return deny(res, 400, body.problem);

    // Parsed here and handed over, so the transport does not have to
    // re-read a stream this has already consumed.
    await options.host.handleRequest(req, res, body.value);
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (res.headersSent) res.end();
      else deny(res, 500, "The MCP server failed to handle that request.");
    });
  });

  // Everything above happens after the token is checked. These three do
  // not, and they are the only ceiling on what an unauthenticated local
  // process can make this socket hold: Node's defaults let it open
  // sockets without limit and sit on each for a minute before sending a
  // header. That costs file descriptors and heap in the *main* process,
  // which is the one drawing the UI. A single-user desktop needs nothing
  // like 64 connections; the number is a backstop, not a budget.
  server.maxConnections = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  return new Promise<ListenResult>((resolve) => {
    function onError(error: NodeJS.ErrnoException): void {
      server.removeListener("error", onError);
      // A port already in use is an ordinary thing that happens on a
      // desktop, not a fault — see index.ts on why EO never fails to
      // start over one.
      const problem =
        error.code === "EADDRINUSE"
          ? `Port ${options.port} is already in use. Choose another in Settings → MCP server.`
          : `The MCP server could not start: ${error.message}`;
      resolve({ ok: false, problem });
    }

    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: options.port }, () => {
      server.removeListener("error", onError);
      const address = server.address();
      boundPort = typeof address === "object" && address !== null ? address.port : options.port;
      resolve({ ok: true, listener: { port: boundPort, close: () => closeListener(server) } });
    });
  });
}

/**
 * Closes the socket, and does not wait forever to do it.
 *
 * `server.close()` stops accepting and then waits for every open
 * connection to end — and an MCP client holding the notification stream
 * open never ends one. Without the race, quitting EO would appear to
 * hang on a socket rather than on anything the person did.
 */
function closeListener(server: HttpServer): Promise<void> {
  return new Promise<void>((resolve) => {
    const forced = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, 2000);
    forced.unref();

    server.close(() => {
      clearTimeout(forced);
      resolve();
    });
  });
}
