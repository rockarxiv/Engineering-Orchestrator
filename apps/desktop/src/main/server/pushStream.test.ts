import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PUSH_STREAM_PATH, PUSH_STREAM_READY_EVENT, PUSH_STREAM_REFETCH_EVENT, pushWireChannel } from "@eo/core";
import { clearHandlerRegistry } from "../ipc/registry.js";
import { sourceTreeResources } from "../testing/platform.js";
import { createPushStream } from "./pushStream.js";
import type { ServerConfig } from "./config.js";
import { startServer, type RunningServer } from "./start.js";
import { removeScratch } from "../testing/scratch.js";

/**
 * Push over a transport that is not `webContents` (EO-321).
 *
 * The first half of this file is the *server's* half of the story's
 * first acceptance criterion, and it is deliberately end to end on that
 * side: a real server on a real socket, real SQLite behind it, two real
 * streams, and `emitPush` — called from inside a handler that one
 * client invoked — reaching a second client that was only listening.
 *
 * It stops at the frame, and says so rather than implying otherwise.
 * What a renderer *does* with that frame is not observable from here:
 * there is no React in this process and there cannot be, because
 * `tsconfig.node.json` covers `src/main/**` and a renderer import would
 * drag DOM-typed files into a node program. So the board half of the
 * criterion is `renderer/src/ipc/servedClients.test.tsx`, which mounts
 * two whole clients — two bridges, two push streams, two query caches,
 * the real `AppShell`, `Archive` and `ItemList` — and presses Restore
 * in one browser to watch the row appear on the other's board. The two
 * files meet on the wire, and the wire is core's: `PUSH_STREAM_PATH`,
 * the two event names and `pushWireChannel` are imported by both rather
 * than spelled in either.
 *
 * The second half is the hub on its own, for the two things a socket
 * does that a window does not: come back, and fall behind. Both are
 * answered with a `refetch` rather than a replay, and both are easier
 * to provoke with a client that is a fake than with one that is a
 * browser.
 *
 * The mocks below are `smoke.test.ts`'s, for its reason: a single
 * `import "electron"` anywhere in the graph this pulls in fails these
 * tests. A server binary that loaded Electron would not be a server
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

let running: { server: RunningServer; directory: string } | null = null;
const openStreams = new Set<StreamClient>();

afterEach(async () => {
  for (const stream of openStreams) stream.close();
  openStreams.clear();
  clearHandlerRegistry();
  if (running === null) return;
  const { server, directory } = running;
  running = null;
  await server.main.stop();
  await server.platform.stopServing();
  server.release();
  removeScratch(directory);
});

/** A server on a temporary data directory and a free port — `smoke.test.ts`'s. */
function start(): RunningServer {
  const directory = mkdtempSync(join(tmpdir(), "eo-push-"));
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

/** Where it actually bound. `listen` is asynchronous, so this waits for it. */
async function origin(server: RunningServer): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const address = server.platform.address();
    if (address !== null) return `http://${address.host}:${address.port}`;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The server never bound a port.");
}

function call(base: string, channel: string, payload: unknown): Promise<Response> {
  return fetch(`${base}/ipc/${channel}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ payload }),
  });
}

// ─── A browser client, in as few lines as one can be written ──────────

interface Frame {
  event: string;
  data: unknown;
  id: string | null;
}

interface StreamClient {
  status: number;
  frames: Frame[];
  /** Resolves on the next frame of this event, or one already received. */
  waitFor(event: string): Promise<Frame>;
  close(): void;
}

/**
 * Opens a push stream and reads it in the background.
 *
 * Written here rather than imported from the renderer on purpose: the
 * renderer's client is the other thing under test, and a test that used
 * it to check the server would be agreeing with itself. This one reads
 * only what SSE says is there.
 */
async function openStream(base: string, init: { token?: string | null; lastEventId?: string } = {}): Promise<StreamClient> {
  const token = init.token === undefined ? TOKEN : init.token;
  const controller = new AbortController();
  const response = await fetch(`${base}${PUSH_STREAM_PATH}`, {
    headers: {
      accept: "text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(init.lastEventId === undefined ? {} : { "last-event-id": init.lastEventId }),
    },
    signal: controller.signal,
  });

  const frames: Frame[] = [];
  const waiting: { event: string; resolve: (frame: Frame) => void }[] = [];

  const client: StreamClient = {
    status: response.status,
    frames,
    waitFor(event) {
      const already = frames.find((frame) => frame.event === event);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no "${event}" arrived; saw ${frames.map((f) => f.event).join(", ") || "nothing"}`)), 10_000);
        waiting.push({
          event,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
    close: () => controller.abort(),
  };
  openStreams.add(client);

  if (!response.ok || !response.body) {
    // Nothing to read, and a body nobody drains holds a socket open
    // past the end of the test.
    await response.body?.cancel();
  } else {
    const reader = response.body.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const frame = parse(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
            if (frame === null) continue;
            frames.push(frame);
            const index = waiting.findIndex((one) => one.event === frame.event);
            if (index !== -1) waiting.splice(index, 1)[0]?.resolve(frame);
          }
        }
      } catch {
        // The stream ended — aborted by `close`, or the server stopped.
      }
    })();
  }

  return client;
}

function parse(raw: string): Frame | null {
  let event = "message";
  let data: string | null = null;
  let id: string | null = null;
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data = value;
  }
  if (data === null) return null;
  return { event, data: JSON.parse(data), id };
}

// ─── The acceptance criterion ─────────────────────────────────────────

describe("two browser clients on one server", () => {
  it("carries a change one of them made to the other, with nobody asking", async () => {
    const server = start();
    const base = await origin(server);

    // Two tabs, two sockets. Neither knows about the other, and the
    // second is doing nothing but listening.
    const [alice, bob] = await Promise.all([openStream(base), openStream(base)]);
    await Promise.all([alice.waitFor(PUSH_STREAM_READY_EVENT), bob.waitFor(PUSH_STREAM_READY_EVENT)]);

    // One of them makes a change, through the ordinary record door.
    const created = (await (await call(base, "projects:create", { name: "Apollo", keyPrefix: "APO", repositoryIds: [] })).json()) as {
      ok: boolean;
      data: { ok: boolean; problem: string | null };
    };
    expect(created).toMatchObject({ ok: true, data: { ok: true, problem: null } });

    // `emitPush`, called inside the handler, reached both — the one that
    // asked and the one that was only listening. The second is the whole
    // point: that is the browser nobody touched.
    const heard = await Promise.all([alice.waitFor(pushWireChannel("config:changed")), bob.waitFor(pushWireChannel("config:changed"))]);
    expect(heard.map((frame) => frame.data)).toEqual([{}, {}]);

    // And the push was about something that really happened: the record
    // this server holds now has the project in it. Asked for by this
    // test rather than by a listener — there is no renderer in this
    // process to do the asking, and pretending otherwise is what the
    // comment here used to do. The listener's half is
    // `servedClients.test.tsx`, where a board refetches itself.
    const listed = (await (await call(base, "projects:list", undefined)).json()) as { data: { projects: { name: string }[] } };
    expect(listed.data.projects.map((project) => project.name)).toEqual(["Apollo"]);
  });

  it("carries the board's own channel, and carries its payload intact", async () => {
    const server = start();
    const base = await origin(server);
    const watcher = await openStream(base);
    await watcher.waitFor(PUSH_STREAM_READY_EVENT);

    // `emitPush` directly, because this is about the transport rather
    // than about any one handler: the test above proves a handler
    // reaches it, and what is left to establish is that the stream is
    // bridged to the *whole* contract and not to the channel it was
    // written against. A transport carrying only `config:changed` would
    // pass the test above and leave every board dead.
    const { emitPush } = await import("../ipc/push.js");
    emitPush("items:changed", { itemId: "01a00000-0000-7000-8000-000000000000" });
    emitPush("runs:changed", { runId: "r-1", itemId: "i-1", status: "running" });

    expect((await watcher.waitFor(pushWireChannel("items:changed"))).data).toEqual({ itemId: "01a00000-0000-7000-8000-000000000000" });
    // A payload that is not `{}` survives the round trip — a stream that
    // dropped the body would be indistinguishable on an invalidation.
    expect((await watcher.waitFor(pushWireChannel("runs:changed"))).data).toEqual({ runId: "r-1", itemId: "i-1", status: "running" });
  });

  it("carries an assistant chat's delta with its messages intact (EO-553)", async () => {
    const server = start();
    const base = await origin(server);
    const watcher = await openStream(base);
    await watcher.waitFor(PUSH_STREAM_READY_EVENT);

    // The one push that carries a change rather than a doorbell: a stream
    // that dropped or reshaped its messages would leave a served chat
    // drawing them wrong, where a desktop drew them right.
    const delta = {
      conversationId: "01a00000-0000-7000-8000-000000000001",
      seq: 3,
      messages: [
        {
          id: "01a00000-0000-7000-8000-000000000002",
          authorType: "agent" as const,
          authorName: "Assistant",
          body: "Two items wait on the Apollo board.",
          attachments: [],
          kind: "note",
          parentId: null,
          runId: "01a00000-0000-7000-8000-000000000003",
          options: null,
          canAnswer: false,
          createdAt: 1,
          canApprove: false,
          approves: null,
          moduleSlug: null,
          proposedType: null,
          status: null,
        },
      ],
      messageIds: ["01a00000-0000-7000-8000-000000000002"],
      earlier: 0,
      resync: false,
    };
    const { emitPush } = await import("../ipc/push.js");
    emitPush("assist:delta", delta);

    expect((await watcher.waitFor(pushWireChannel("assist:delta"))).data).toEqual(delta);
  });

  it("needs the same token the channels do, and answers a GET only", async () => {
    const server = start();
    const base = await origin(server);

    expect((await openStream(base, { token: null })).status).toBe(401);
    expect((await openStream(base, { token: "not-the-token" })).status).toBe(401);

    const posted = await fetch(`${base}${PUSH_STREAM_PATH}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(posted.status).toBe(405);
    await posted.body?.cancel();
  });

  it("tells a client that has been here before to ask for everything again", async () => {
    const server = start();
    const base = await origin(server);

    // First connection: an id and nothing to do with it. A `refetch`
    // here would be a whole cache thrown away on every page load.
    const first = await openStream(base);
    const ready = await first.waitFor(PUSH_STREAM_READY_EVENT);
    expect(ready.id).not.toBeNull();
    first.close();

    // …and back again, presenting what it was last sent. Not replayed
    // to — told to ask.
    const second = await openStream(base, { lastEventId: ready.id ?? "1" });
    const refetch = await second.waitFor(PUSH_STREAM_REFETCH_EVENT);

    expect(refetch.data).toEqual({});
    expect(second.frames.some((frame) => frame.event === PUSH_STREAM_READY_EVENT)).toBe(false);
  });
});

// ─── The hub, where a fake client can be made to misbehave ────────────

/** A response that can be told to stop accepting writes. */
function fakePair(lastEventId?: string): {
  request: IncomingMessage;
  response: ServerResponse;
  written: string[];
  stopAccepting(): void;
  drain(): void;
} {
  const written: string[] = [];
  let accepting = true;
  const emitter = new EventEmitter();
  const response = Object.assign(emitter, {
    writeHead: () => response,
    flushHeaders: () => {},
    write: (text: string) => {
      written.push(text);
      return accepting;
    },
    end: () => {
      emitter.emit("close");
    },
  }) as unknown as ServerResponse;

  const request = {
    headers: lastEventId === undefined ? {} : { "last-event-id": lastEventId },
    socket: { setNoDelay: () => {}, setTimeout: () => {} },
  } as unknown as IncomingMessage;

  return {
    request,
    response,
    written,
    stopAccepting: () => {
      accepting = false;
    },
    drain: () => {
      accepting = true;
      emitter.emit("drain");
    },
  };
}

function eventsIn(written: string[]): string[] {
  return written.flatMap((frame) => /event: (.+)/.exec(frame)?.[1] ?? []);
}

describe("a client that cannot keep up", () => {
  it("is sent nothing more until it drains, and then one refetch", () => {
    const stream = createPushStream();
    const client = fakePair();
    stream.attach(client.request, client.response);
    client.written.length = 0;

    // The write that fills the buffer is still delivered — Node took it,
    // it just will not take another. Everything after it is dropped
    // rather than queued, which is the difference between a tab that
    // went to sleep costing a frame and costing this process its memory.
    client.stopAccepting();
    stream.send(pushWireChannel("items:changed"), {});
    for (let more = 0; more < 50; more += 1) stream.send(pushWireChannel("config:changed"), {});

    expect(eventsIn(client.written)).toEqual([pushWireChannel("items:changed")]);

    client.drain();

    // One `refetch` stands in for the fifty. It says as much as they
    // did, because each of them said only "ask again".
    expect(eventsIn(client.written)).toEqual([pushWireChannel("items:changed"), PUSH_STREAM_REFETCH_EVENT]);
  });

  it("owes nothing when it drains without having missed anything", () => {
    const stream = createPushStream();
    const client = fakePair();
    stream.attach(client.request, client.response);
    client.written.length = 0;

    client.stopAccepting();
    stream.send(pushWireChannel("items:changed"), {});
    client.drain();

    // The one that filled the buffer arrived. A `refetch` after it would
    // be a whole cache invalidated because a socket paused for a
    // millisecond.
    expect(eventsIn(client.written)).toEqual([pushWireChannel("items:changed")]);
  });
});

describe("the hub's bookkeeping", () => {
  it("forgets a client whose socket closed, and stops writing to it", () => {
    const stream = createPushStream();
    const first = fakePair();
    const second = fakePair();
    stream.attach(first.request, first.response);
    stream.attach(second.request, second.response);
    expect(stream.clientCount()).toBe(2);

    first.response.end();
    expect(stream.clientCount()).toBe(1);

    first.written.length = 0;
    stream.send(pushWireChannel("items:changed"), {});
    expect(first.written).toEqual([]);
    expect(eventsIn(second.written)).toContain(pushWireChannel("items:changed"));
  });

  it("gives every client the same frame, with an id that moves", () => {
    const stream = createPushStream();
    const client = fakePair();
    stream.attach(client.request, client.response);
    client.written.length = 0;

    stream.send(pushWireChannel("runs:changed"), { runId: "r", itemId: "i", status: "running" });
    stream.send(pushWireChannel("runs:progress"), { runId: "r" });

    const ids = client.written.flatMap((frame) => /id: (\d+)/.exec(frame)?.[1] ?? []);
    expect(ids).toEqual(["1", "2"]);
    expect(client.written[0]).toContain('data: {"runId":"r","itemId":"i","status":"running"}');
  });

  it("writes a comment down an idle stream, and a comment moves nothing", async () => {
    // Faster than any real one, for the same reason `port: 0` is used
    // above: a test that waits 25 seconds to watch a byte is a test
    // nobody runs.
    const stream = createPushStream({ heartbeatMs: 5 });
    const client = fakePair();
    stream.attach(client.request, client.response);
    client.written.length = 0;

    await vi.waitFor(() => expect(client.written.join("")).toContain(": keep-alive"));

    // Not an event: no id moved and no listener woke. It exists so that
    // an intermediary with an idle timeout does not close a stream that
    // has simply had nothing to say, and so that a socket which has gone
    // half-open is found out here rather than never.
    expect(eventsIn(client.written)).toEqual([]);
    stream.close();
  });

  it("ends every stream when the server stops serving", () => {
    const stream = createPushStream();
    const client = fakePair();
    stream.attach(client.request, client.response);

    stream.close();

    expect(stream.clientCount()).toBe(0);
  });
});
