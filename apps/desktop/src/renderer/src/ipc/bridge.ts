import {
  ipcPushContract,
  isMachineChannel,
  isUnauthenticatedChannel,
  machineOnlyRefusal,
  pushWireChannel,
  type IpcChannel,
  type IpcPushChannel,
  type IpcPushPayload,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
} from "@eo/core";
import { openPushStream, type PushStreamHandle } from "./pushStream";

/**
 * How the renderer reaches the main process — chosen once, at startup
 * (EO-319, `ARCHITECTURE.md`, "The server").
 *
 * The same renderer runs in two places now. Under Electron it is loaded
 * by a `BrowserWindow` and the preload has already put `window.eo` in
 * front of it, which is `ipcRenderer` and has always been. Served from
 * an organisation server it is a page in somebody's browser, there is no
 * preload, and the main process is on the other end of a socket.
 *
 * Every screen goes through this rather than through `window.eo`
 * directly, so that neither has to know which of the two it is. What a
 * screen *does* sometimes need to know is the one difference that is not
 * transport — whether there is a machine here at all — and that is
 * `machineAvailable`, below.
 */
export interface RendererBridge {
  invoke<K extends IpcChannel>(channel: K, payload: IpcRequest<K>): Promise<IpcResult<IpcResponse<K>>>;
  subscribe<K extends IpcPushChannel>(channel: K, callback: (payload: IpcPushPayload<K>) => void): () => void;
  /**
   * Whether the machine half of the contract can be answered here
   * (`packages/core/src/ipc.ts`).
   *
   * True on a desktop and false on a server, and it is not a guess: a
   * server refuses those channels at its door, so a control that calls
   * one has nothing behind it. Screens read this to leave such a control
   * out rather than to show one that cannot work — which is invariant 12
   * exactly, an absence named where the person can see it instead of
   * left to be discovered.
   */
  readonly machineAvailable: boolean;
  /**
   * "Whatever you know may be stale — ask for all of it again"
   * (EO-321).
   *
   * A transport-level event rather than a push: no handler emits it and
   * it is not in `ipcPushContract`. It is what a *connection* says when
   * it has been away, and the only transport that can be away is the
   * one with a socket in it. Under Electron the preload cannot be
   * disconnected from the process it is part of — if main is gone, so
   * is the window — so the Electron implementation subscribes nobody
   * and that is the honest answer rather than a gap.
   *
   * One listener is expected: `RefetchOnReconnect`, which invalidates
   * the whole query cache. See `PUSH_STREAM_REFETCH_EVENT` in core for
   * why that is equivalent to replaying what was missed.
   */
  subscribeRefetch(callback: () => void): () => void;
  /**
   * Lets go of whatever the transport is holding open.
   *
   * Absent under Electron, which holds nothing. `setBridge(undefined)`
   * calls it, which is how a file of tests describing both transports
   * does not leave a reconnection loop running behind it — see there
   * for why only the clearing call does.
   */
  close?(): void;
}

/**
 * Where a browser keeps the admin token it was given.
 *
 * `sessionStorage` rather than `localStorage`, deliberately: this is a
 * single shared secret standing in until real sign-in lands (7b), and a
 * stand-in should not outlive the tab it was pasted into.
 */
const TOKEN_KEY = "eo.serverToken";

let chosen: RendererBridge | undefined;

/** The transport, resolved on first use and never again. */
export function bridge(): RendererBridge {
  chosen ??= typeof window !== "undefined" && window.eo !== undefined ? preloadBridge() : createHttpBridge();
  return chosen;
}

/**
 * Whether this tab holds a credential for the server it was served by
 * (EO-326).
 *
 * The question a browser asks before it draws anything: with no token
 * every record channel comes back "this EO server needs its admin
 * token", which is a sentence about a stand-in rather than an invitation
 * to sign in. `ServedSignIn` reads this and offers the front door
 * instead.
 *
 * Always true on a desktop, which has no token and needs none — the
 * person at the keyboard owns the machine. Answering anything else here
 * would put a sign-in form in front of a solo installation.
 */
export function hasServerCredential(): boolean {
  if (machineAvailable()) return true;
  return serverToken() !== null;
}

/**
 * Keeps the token a sign-in just minted, and the device row it is for
 * (EO-326, ARCHITECTURE.md, "Identity").
 *
 * The token goes where the operator's stand-in goes — `sessionStorage`,
 * so a credential does not outlive the tab it was typed into, which is
 * the right default for a shared or borrowed machine.
 *
 * The device id goes to `localStorage`, which is the opposite choice and
 * the right one for the opposite reason: it is not a secret, and it is
 * what stops the admin's Devices list growing a row every time somebody
 * opens the address and signs in. A desktop keeps it in `app_settings`
 * for exactly this (`rememberedDeviceId`); a browser has no settings
 * table and this is the nearest honest thing.
 */
export function rememberServerCredential(token: string, deviceId: string): void {
  window.sessionStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(DEVICE_KEY, deviceId);
}

/** The device row this browser last signed in as, so a new sign-in re-uses it. */
export function rememberedDeviceId(): string | undefined {
  const id = window.localStorage.getItem(DEVICE_KEY);
  return id === null || id === "" ? undefined : id;
}

/** Where a browser remembers which device row it is. Not a secret — see `rememberServerCredential`. */
const DEVICE_KEY = "eo.deviceId";

/** Whether the machine half can be answered here — see `RendererBridge.machineAvailable`. */
export function machineAvailable(): boolean {
  return bridge().machineAvailable;
}

/**
 * Tests only, and the same seam `clearHandlerRegistry` is in the main
 * process: the choice is made once per page load, which is right for a
 * page and wrong for a file of tests that has to describe both.
 *
 * Clearing it — `setBridge(undefined)` — also closes what was
 * installed, because that is the teardown call and a reconnection loop
 * outliving the test that started it is nobody's intention. Installing
 * one does *not* close the last, because the caller may still hold it:
 * `servedClients.test.tsx` keeps two alive at once and switches between
 * them, which is the only way one process can be two browsers.
 */
export function setBridge(next: RendererBridge | undefined): void {
  if (next === undefined) chosen?.close?.();
  chosen = next;
}

/**
 * Under Electron: the preload's bridge, unchanged.
 *
 * `window.eo` is read per call rather than captured, because the object
 * is the preload's and a test replaces it between cases.
 */
function preloadBridge(): RendererBridge {
  return {
    machineAvailable: true,
    invoke: (channel, payload) => window.eo.ipc.invoke(channel, payload),
    subscribe: (channel, callback) => window.eo.ipc.subscribe(channel, callback),
    // Nothing to say, ever — see `subscribeRefetch` on the interface.
    // A disposer rather than nothing, because every caller is a
    // `useEffect` cleanup.
    subscribeRefetch: () => () => {},
  };
}

/**
 * Served from a server: the record half, over HTTP.
 *
 * Same origin, so no URL to configure — the page came from the process
 * that answers it. The envelope is the contract on this side too: a
 * network failure and a refused token come back as `{ ok: false }` with
 * a sentence, because a renderer that had to catch exceptions from one
 * transport and read envelopes from the other would be two renderers.
 *
 * Requests go out over `fetch` and pushes come back over one
 * server-sent-event stream (EO-321). There is exactly one stream per
 * page however many screens are listening: `subscribe` is a
 * subscription to a name, not to a connection, and the connection is
 * opened the first time anybody asks for one.
 *
 * Exported, where the Electron half above is not, and for exactly one
 * reason: a page has one of these and a test about *two browsers* needs
 * two. `bridge()` is the singleton production uses and the only thing
 * any screen calls.
 */
export function createHttpBridge(): RendererBridge {
  /** Listeners by wire channel — the name the server actually sends. */
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const refetchers = new Set<() => void>();
  let stream: PushStreamHandle | null = null;

  /**
   * The wire name back to the channel it stands for.
   *
   * Built once from the contract rather than by stripping a prefix,
   * because the prefix is `pushWireChannel`'s business and this is the
   * only other place that has to undo it.
   */
  const byWireChannel = new Map<string, IpcPushChannel>(
    (Object.keys(ipcPushContract) as IpcPushChannel[]).map((channel) => [pushWireChannel(channel), channel]),
  );

  /**
   * Opened on the first subscription and left open.
   *
   * Not closed when the last listener goes: subscriptions come and go
   * with every navigation, and a stream torn down and rebuilt between
   * two screens would present a `Last-Event-ID` each time and be
   * answered with a `refetch` — the whole cache invalidated because
   * somebody clicked from the board to Settings. It is closed when the
   * page goes, and by `close()` for a test.
   */
  const ensureStream = (): void => {
    stream ??= openPushStream({
      token: serverToken,
      deliver,
      refetch: () => {
        for (const listener of [...refetchers]) listener();
      },
      unauthorized: () => window.sessionStorage.removeItem(TOKEN_KEY),
    });
  };

  /**
   * One push, checked against the contract before any screen sees it.
   *
   * Checked because this arrives over a network from a process that may
   * not be the one this bundle was built with — a browser tab open
   * across a server upgrade is the ordinary case, not an exotic one. A
   * channel this bundle does not know is ignored, which is what a tab
   * one version behind should do with a push invented after it loaded;
   * a payload that does not parse is dropped with a line in the console,
   * because delivering a shape a screen will destructure is how one
   * stale frame becomes a blank window.
   */
  function deliver(wireChannel: string, payload: unknown): void {
    const heard = listeners.get(wireChannel);
    if (heard === undefined || heard.size === 0) return;

    const channel = byWireChannel.get(wireChannel);
    if (channel === undefined) return;
    const parsed = ipcPushContract[channel].safeParse(payload);
    if (!parsed.success) {
      console.warn(`[eo] ignored a push on "${channel}" that did not match its own schema:`, parsed.error.message);
      return;
    }

    // A copy, because a listener may unsubscribe itself while being
    // called — a React effect cleanup running inside a state update.
    for (const listener of [...heard]) listener(parsed.data);
  }

  return {
    machineAvailable: false,

    async invoke(channel, payload) {
      // Refused here rather than at the far end. The answer is the same
      // sentence either way — it is core's, and the server's door reads
      // it from the same function — and there is no reason to spend a
      // round trip being told what this transport already knows.
      if (isMachineChannel(channel)) return machineOnlyRefusal(channel);

      // The two channels a caller reaches before it is anybody (EO-323).
      //
      // This transport used to demand a token before every request, and
      // that made the invitation link unusable in the one place it is
      // ever opened: a colleague following `/invite/<code>` has no
      // token, has never had one, and is not supposed to — the code in
      // the link is the whole of what admits them. They were told to
      // "open the address the server printed", which is the admin's
      // address and not something they have, and the request never
      // reached the channel the server had deliberately left open.
      //
      // So the rule this side keeps is the rule the server's door keeps,
      // read from the same list: everything needs a token except these,
      // and these are admitted on what they carry.
      // Deliberately not read at all for those two, rather than read and
      // sent anyway. An open channel is judged on what it carries — a
      // code, a password — and a token presented beside it would make a
      // 401 about the invitation ambiguous with a 401 about the tab: an
      // admin accepting an invitation in their own window would be
      // signed out of it by somebody else's expired link.
      const open = isUnauthenticatedChannel(channel);
      const token = open ? null : serverToken();
      if (token === null && !open) {
        return {
          ok: false,
          error: {
            message:
              "This EO server needs its admin token. Open the address the server printed when it started — it carries the token in the URL.",
          },
        };
      }

      try {
        const response = await fetch(`/ipc/${encodeURIComponent(channel)}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Omitted entirely when there is none — which is always,
            // on the two open channels — because `Bearer null` is a
            // token, and a wrong one.
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
          // Wrapped, so a channel taking `z.void()` is distinguishable
          // from a body that never said anything — see http.ts.
          body: JSON.stringify({ payload }),
        });

        if (response.status === 401) {
          // Cleared, so that a token which has stopped working is asked
          // for again rather than resent on every query for the rest of
          // the session. Only when one was actually presented: a 401 on
          // a request that carried none says nothing about the token
          // this tab is holding for its admin.
          if (token !== null) window.sessionStorage.removeItem(TOKEN_KEY);
          return { ok: false, error: { message: "This EO server did not accept that admin token." } };
        }

        return (await response.json()) as IpcResult<IpcResponse<typeof channel>>;
      } catch (error) {
        return { ok: false, error: { message: `EO could not reach its server: ${String(error)}` } };
      }
    },

    subscribe(channel, callback) {
      const wireChannel = pushWireChannel(channel);
      const heard = listeners.get(wireChannel) ?? new Set<(payload: unknown) => void>();
      listeners.set(wireChannel, heard);
      // The cast is the one place the contract's per-channel payload
      // type is widened, and it is sound because `deliver` narrows it
      // back with that same channel's schema before calling this.
      const listener = callback as (payload: unknown) => void;
      heard.add(listener);
      ensureStream();
      return () => heard.delete(listener);
    },

    subscribeRefetch(callback) {
      refetchers.add(callback);
      // A page that only wants to know about reconnections still needs
      // a connection to reconnect on.
      ensureStream();
      return () => refetchers.delete(callback);
    },

    close() {
      stream?.close();
      stream = null;
      listeners.clear();
      refetchers.clear();
    },
  };
}

/**
 * The operator's token, from the URL the server printed or from where
 * this tab put it.
 *
 * The address an admin opens is the address that carries it, the way a
 * notebook server's does. It stayed that way after sign-in shipped
 * (EO-323), because it is how somebody reaches a server whose people
 * list is empty — which is every server on its first boot, since the
 * first invitation has to be written by somebody.
 *
 * It is taken out of the URL on arrival so that it is not in the address
 * bar to be copied into a chat window, and not in `document.referrer` of
 * anything this page links to.
 *
 * Null is a normal state rather than a failure: a colleague who followed
 * an invitation link has no token and needs none — see `invoke`.
 */
function serverToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token") ?? new URLSearchParams(url.hash.replace(/^#/, "")).get("token");
  if (fromUrl !== null && fromUrl.length > 0) {
    window.sessionStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete("token");
    url.hash = "";
    window.history.replaceState(null, "", url.toString());
    return fromUrl;
  }
  return window.sessionStorage.getItem(TOKEN_KEY);
}
