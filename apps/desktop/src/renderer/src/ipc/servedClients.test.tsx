import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor, within, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_GIT_STATE,
  PUSH_STREAM_PATH,
  PUSH_STREAM_READY_EVENT,
  PUSH_STREAM_REFETCH_EVENT,
  pushWireChannel,
  type ItemSummary,
  type PipelineView,
} from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { ChatWindow } from "../chat/ChatFrame";
import { ItemReferenceProvider } from "../chat/conversation/ItemReferenceProvider";
import { createQueryClient } from "../query/client";
import { RefetchOnReconnect } from "../query/RefetchOnReconnect";
import { ViewPublisher } from "../shared/view/ViewPublisher";
import { createHttpBridge, setBridge, type RendererBridge } from "./bridge";
import { RowsViewport } from "../chat/kit/testing";

/**
 * Two browser clients on one server (EO-321, the story's first
 * acceptance criterion).
 *
 * The claim is about a *board*, so this is boards: two whole renderers,
 * each with its own `createHttpBridge`, its own push stream, its own
 * `QueryClient` and its own React tree, and the real window in each —
 * `ChatWindow` (`chat/ChatFrame.tsx`), which is where `items:changed` is
 * subscribed for the whole window, opened on the address a person would
 * be at: the archive view in one, the items view in the other. Somebody
 * presses Restore in one browser and the row appears on the other
 * browser's list, with nothing in this test asking for it.
 *
 * Nothing between the two is mocked below the bridge: the frames are
 * real server-sent events, parsed by the real `openPushStream`,
 * dispatched by the real `subscribe`, acted on by the real
 * `useInvalidateOnPush`, and the refetch that follows goes back over
 * the real `invoke`. The test never calls `items:list` — the assertion
 * at the end of the first case is precisely that it did not have to.
 *
 * ### What is a double here, and why it has to be
 *
 * The far end. A renderer test cannot start the server: `tsconfig.web.json`
 * covers `src/renderer/src/**` and a main-process import would drag
 * node-typed files into a DOM program, which is the boundary working
 * rather than an inconvenience. So `servedServer()` below answers the
 * wire, and the wire is the contract — `PUSH_STREAM_PATH`,
 * `PUSH_STREAM_READY_EVENT`, `PUSH_STREAM_REFETCH_EVENT` and
 * `pushWireChannel` are imported from core rather than spelled here, so
 * the two ends cannot drift by a string.
 *
 * The other half of the criterion is `main/server/pushStream.test.ts`,
 * which holds the *real* server to the same wire with a real socket,
 * real SQLite and two clients: `emitPush` inside a handler one client
 * invoked reaching a second client that was only listening. Between
 * them there is no hop left uncovered.
 */

// ─── The server, as far as a browser can see one ──────────────────────

interface Stream {
  send(text: string): void;
  end(): void;
  /** Whether it presented a `Last-Event-ID` — see `PUSH_STREAM_REFETCH_EVENT`. */
  returning: boolean;
}

interface ServedServer {
  /** On the board. */
  live: ItemSummary[];
  /** Put away. */
  archived: ItemSummary[];
  /** Every stream a client is holding, oldest first. */
  streams: Stream[];
  /** Every channel anybody asked for, so the test can prove what it did not ask. */
  asked: string[];
}

/**
 * One SSE frame, spelled the way the server spells it.
 *
 * `server/pushStream.ts` writes exactly this; the format is SSE's and
 * the names are core's.
 */
function frame(event: string, data: unknown, id: number): string {
  return `id: ${String(id)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function servedServer(initial: { live?: ItemSummary[]; archived?: ItemSummary[] } = {}): ServedServer {
  const server: ServedServer = {
    live: initial.live ?? [],
    archived: initial.archived ?? [],
    streams: [],
    asked: [],
  };
  let lastId = 0;

  const broadcast = (wireChannel: string, payload: unknown): void => {
    lastId += 1;
    const text = frame(wireChannel, payload, lastId);
    for (const stream of server.streams) stream.send(text);
  };

  const attach = (init: RequestInit): Response => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const returning = typeof headers["last-event-id"] === "string";
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(given) {
        controller = given;
      },
    });
    const stream: Stream = {
      returning,
      send: (text) => controller?.enqueue(new TextEncoder().encode(text)),
      end: () => controller?.close(),
    };
    server.streams.push(stream);
    // A client that has been here before is told to ask for everything
    // again; one arriving for the first time is given an id and nothing
    // to do with it.
    stream.send(frame(returning ? PUSH_STREAM_REFETCH_EVENT : PUSH_STREAM_READY_EVENT, {}, lastId));
    return { ok: true, status: 200, body } as unknown as Response;
  };

  const answer = async (channel: string, payload: unknown): Promise<unknown> => {
    server.asked.push(channel);
    switch (channel) {
      // Copied, not handed out. A real answer arrives over a socket and
      // is parsed fresh every time; handing back the array this server
      // mutates in place would give TanStack Query the identical
      // reference it already holds, and structural sharing would
      // correctly conclude that nothing had changed — a test that
      // passed the push through and then failed to notice it.
      case "items:list":
        return { ok: true, data: { items: [...server.live] } };
      case "items:listArchived":
        return { ok: true, data: { items: [...server.archived] } };
      case "items:setArchived": {
        const { itemId, archived } = payload as { itemId: string; archived: boolean };
        const from = archived ? server.live : server.archived;
        const to = archived ? server.archived : server.live;
        const moving = from.find((item) => item.id === itemId);
        if (moving === undefined) return { ok: true, data: { archived, problem: "no such item" } };
        from.splice(from.indexOf(moving), 1);
        to.push(moving);
        // Where the real handler announces it, and with the payload the
        // real handler uses: every window, not just the one that asked.
        broadcast(pushWireChannel("items:changed"), {});
        return { ok: true, data: { archived, problem: null } };
      }
      case "projects:list":
        return {
          ok: true,
          data: {
            projects: [{ id: "p1", name: "EO", keyPrefix: "EO", jiraProjectId: null, repositoryIds: ["r1"], itemCount: 1 }],
            activeProjectId: "p1",
          },
        };
      case "pipelines:list":
        return { ok: true, data: { pipelines: [pipeline()] } };
      default:
        // Everything this test is not about, from setupTests.ts's
        // correctly-shaped empties — the same delegation
        // `serverSurface.test.tsx` uses, so this file stays about the
        // one thing it is testing rather than about re-stubbing ninety
        // channels.
        return window.eo.ipc.invoke(channel as never, payload as never);
    }
  };

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init: RequestInit) => {
      if (input === PUSH_STREAM_PATH) return Promise.resolve(attach(init));
      const channel = decodeURIComponent(input.slice("/ipc/".length));
      const payload = (JSON.parse(String(init.body)) as { payload?: unknown }).payload;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => answer(channel, payload),
      } as unknown as Response);
    }),
  );

  return server;
}

// ─── A browser, holding the app ───────────────────────────────────────

interface Client {
  bridge: RendererBridge;
  tree: RenderResult;
  /** The rendered document, for `within` — two boards are on one page here. */
  screen: HTMLElement;
}

const clients: Client[] = [];

/**
 * Mounts one browser's worth of EO, on its own transport, at `at`.
 *
 * `bridge()` is a module singleton, which is exactly right for a page:
 * a browser has one transport. Two browsers are two processes, and in
 * one test process they are two instances of it — so the singleton is
 * switched to whichever client is acting. It matters at mount, because
 * that is when each screen's `useInvalidateOnPush` binds to a stream,
 * and at the moment one of them makes a change.
 */
function openClient(at: string): Client {
  const bridge = createHttpBridge();
  setBridge(bridge);
  const tree = render(
    <RowsViewport>
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          {/* As `App` mounts it: under the provider, above every screen. */}
          <RefetchOnReconnect />
          {/* A memory router where `App` has a hash router: two browsers
              on one page cannot share one address bar. */}
          <MemoryRouter initialEntries={[at]}>
            <ViewPublisher>
              <ItemReferenceProvider>
                {/* The window is not decoration here — it is where
                    `items:changed` is subscribed for the whole window, and
                    it draws whichever view the address names. */}
                <ChatWindow />
              </ItemReferenceProvider>
            </ViewPublisher>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </RowsViewport>,
  );
  const client: Client = { bridge, tree, screen: tree.container };
  clients.push(client);
  return client;
}

/** Puts this client's transport back in front, for whatever it does next. */
function acting(client: Client): Client {
  setBridge(client.bridge);
  return client;
}

/**
 * The page the server printed, token and all — `bridge.ts`'s `serverToken`.
 *
 * A whole URL rather than just its `href`, because the window reads
 * `search` too: it is how a canvas window knows it is one (EO-383), and
 * this page is not.
 */
function arrive(): void {
  vi.stubGlobal("location", new URL("http://eo.example/?token=an-admin-token"));
  vi.stubGlobal("history", { replaceState: vi.fn() });
}

afterEach(() => {
  for (const client of clients) {
    client.tree.unmount();
    client.bridge.close?.();
  }
  clients.length = 0;
  setBridge(undefined);
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

// ─── Fixtures ─────────────────────────────────────────────────────────

function item(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: "t1",
    key: "EO-1",
    type: "story",
    typeLabel: "Story",
    container: false,
    parentId: null,
    parentKey: null,
    parentTitle: null,
    repositoryId: "r1",
    repositoryName: "api",
    projectId: "p1",
    title: "Rate limit the API",
    pipelineId: "pipe-1",
    stepId: "step-impl",
    pipelineVersion: null,
    stepName: "Implementer",
    progress: null,
    priority: 0,
    git: NO_GIT_STATE,
    workspace: { kind: "git-worktree", mode: "isolated", label: null },
    jiraKey: null,
    jiraUrl: null,
    updatedAt: 1_700_000_000_000,
    stepEnteredAt: 1_700_000_000_000,
    heldAt: null,
    origin: null,
    needsAttention: false,
    atTerminalStep: false,
    openDependencyCount: 0,
    latestRunStatus: null,
    assigneeName: null,
    assigneePerson: null,
    claimable: false,
    preview: false,
    ...overrides,
  };
}

function pipeline(): PipelineView {
  return { id: "pipe-1", projectId: "p1", name: "Delivery", icon: null, entryStepId: "step-impl", position: 0, archivedAt: null };
}

// ─── The acceptance criterion ─────────────────────────────────────────

describe("two browser clients on one server", () => {
  it("shows one client's change on the other client's board, with nobody refreshing", async () => {
    arrive();
    const server = servedServer({ archived: [item()] });

    // Two browsers. One is looking at the archive, the other at the
    // board — which is the ordinary case, two people on two screens,
    // and it is what makes the second one's update unambiguous: the
    // board has no control that could have caused it.
    const archivist = openClient("/archive");
    const board = openClient("/items");

    await waitFor(() => expect(server.streams).toHaveLength(2));
    // Both screens have settled: the archive has its row, the board has
    // none.
    await within(archivist.screen).findByRole("button", { name: /restore/i });
    // The board does not have the row. Asserted before, so that finding
    // it afterwards means it arrived rather than was always there.
    expect(within(board.screen).queryByText("Rate limit the API")).toBeNull();

    // A person presses Restore in the first browser. A real control on a
    // real screen, whose mutation goes over that browser's own bridge.
    acting(archivist);
    fireEvent.click(within(archivist.screen).getByRole("button", { name: /restore/i }));

    // …and the second browser's board gains the row. Nothing in this
    // test asked it to: the server pushed `items:changed` down the
    // second client's stream, `ChatWindow` invalidated `["items"]`, and
    // the query refetched itself.
    expect(await within(board.screen).findByText("Rate limit the API")).toBeInTheDocument();

    // The proof that the refetch was the renderer's and not this test's:
    // every `items:list` in `asked` was issued by a query, because this
    // file calls no channel by hand.
    expect(server.asked.filter((channel) => channel === "items:list").length).toBeGreaterThan(1);
  });

  it("does not move a board whose own client never heard the push", async () => {
    arrive();
    const server = servedServer({ archived: [item()] });

    const archivist = openClient("/archive");
    const board = openClient("/items");
    await waitFor(() => expect(server.streams).toHaveLength(2));
    await within(archivist.screen).findByRole("button", { name: /restore/i });
    expect(within(board.screen).queryByText("Rate limit the API")).toBeNull();

    // The board's stream goes away — a laptop that slept, a proxy that
    // gave up — and this time the push is sent while it is gone. The
    // second client is the last stream to have attached.
    const boardStream = server.streams[1];
    server.streams.splice(1, 1);
    boardStream?.end();

    acting(archivist);
    fireEvent.click(within(archivist.screen).getByRole("button", { name: /restore/i }));

    // The archive loses it, because that client was listening. The board
    // does not gain it, because its client was not — which is the
    // negative the next test needs in order to mean anything.
    await waitFor(() => expect(within(archivist.screen).getByText(/nothing archived yet/i)).toBeInTheDocument());
    expect(within(board.screen).queryByText("Rate limit the API")).toBeNull();

    // And then it comes back. The reconnection presents the id it was
    // last sent, the server answers `refetch` rather than a replay, and
    // `RefetchOnReconnect` turns that into the whole cache — so the
    // board catches up on a push nobody will ever send it again.
    await waitFor(() => expect(server.streams).toHaveLength(2), { timeout: 5000 });
    expect(server.streams[1]?.returning).toBe(true);

    expect(await within(board.screen).findByText("Rate limit the API")).toBeInTheDocument();
  });
});
