import { createServer, type Server } from "node:http";
import { NO_MACHINE_HERE } from "@eo/core";
import type { Platform } from "../ipc/platform.js";
import { bridgePushChannels } from "../ipc/push.js";
import { dispatchIpc } from "../ipc/registry.js";
import type { ResourcePaths } from "../resources.js";
import { createServerSecretStore } from "../secrets/serverStore.js";
import type { ServerConfig } from "../server/config.js";
import { createRequestListener } from "../server/http.js";
import { createPushStream, type PushStream } from "../server/pushStream.js";

/**
 * The Node implementation of `Platform` — an organisation server's
 * answer to what the machine provides (EO-319,
 * `ARCHITECTURE.md`, "The server").
 *
 * The second of the two implementations phase 7a exists to write. The
 * first, `electron.ts`, is a desktop: it has a window, a person in front
 * of it, an OS keychain and dialogs that somebody clicks. This one has
 * none of those, and its whole job is to answer that fact honestly
 * rather than to approximate it. `startMain` composes the identical app
 * on top of either.
 *
 * **It imports no Electron, and nothing it reaches does.** It sits in
 * `platform/` beside the desktop's because this directory is *the
 * machine*, not *Electron* — but that makes it the one file in the tree
 * whose Electron-freedom `electronConfinement.test.ts` would otherwise
 * take on trust, which is why that test names it.
 *
 * ### What it refuses, and how
 *
 * A machine channel asked of this process is refused at the door, in the
 * contract's own words (`server/http.ts`). The members below are the
 * *other* side of the same fact: the ways this platform is asked for a
 * machine from inside the process, by code that is not going over IPC at
 * all. Each answers in its own member's vocabulary, because the
 * interface is the desktop's and they have no envelope to put a code in
 * — `pickDirectory` says nobody picked, `openPath` hands back the
 * sentence `shell.openPath` would have handed back had it failed — and
 * every one of them says the same sentence out loud on the way, from the
 * same place the door's refusal comes from, so there is one wording for
 * "there is no machine here" rather than eleven.
 *
 * ### Push
 *
 * `bridgePushChannels` is called here, onto a stream of server-sent
 * events rather than onto a window (EO-321). `emitPush` is unchanged
 * and so is every caller of it: the difference between one renderer in
 * this process and several in browsers is entirely inside
 * `server/pushStream.ts`.
 *
 * ### What is deliberately not here yet
 *
 * - **TLS** is somebody else's: the design requires it and assumes whatever
 *   terminates it in front of this process, which is why the default
 *   bind is loopback. The desktop refuses a plain-http address that is
 *   not loopback before it sends a password (`core/serverAddress.ts`).
 *
 * Identity and sign-in arrived with EO-323: people, groups, invitations
 * and a token per device that the admin can revoke. The environment's
 * token stayed, and is now the *operator's* rather than the only one —
 * see `HttpDoorOptions.token`.
 */
export interface ServerPlatform extends Platform {
  /** Where it is actually listening, once `openUserInterface` has bound. Null before that. */
  address(): { host: string; port: number } | null;
  /**
   * Closes the socket without ending the process.
   *
   * `quit()` is the way out that a running server takes; this is the way
   * a test takes, and the way `quit()` itself goes before it exits.
   */
  stopServing(): Promise<void>;
}

export interface ServerPlatformOptions {
  config: ServerConfig;
  /** Resolved by the entry point, for the reason `Platform.resources` gives. */
  resources: ResourcePaths;
  /**
   * How this platform ends the process.
   *
   * `process.exit` in production. Overridable for the same reason
   * `fakePlatform` refuses to call it at all: a platform that can end
   * the test runner is a platform nobody can write a test against.
   */
  exit?: (code: number) => void;
}

export function createServerPlatform(options: ServerPlatformOptions): ServerPlatform {
  const { config, resources } = options;
  const exitProcess = options.exit ?? ((code: number) => process.exit(code));

  let httpServer: Server | null = null;
  let pushStream: PushStream | null = null;
  let stopPushBridge: (() => void) | null = null;
  let signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];

  /**
   * "There is no machine here", said once and logged, for a member that
   * has no envelope to carry a code in.
   *
   * The tail is core's, shared with the refusal the door answers a
   * machine channel with, so an admin who meets both meets one
   * explanation. The subject is the capability rather than a channel,
   * because these are reached from inside the process — over IPC they
   * never get this far, the door having refused the channel first.
   */
  const refuse = (capability: string): string => {
    const message = `EO is running as a server and cannot ${capability}. ${NO_MACHINE_HERE}`;
    console.warn(`[eo] ${message}`);
    return message;
  };

  const stopServing = (): Promise<void> => {
    for (const { signal, handler } of signalHandlers) process.off(signal, handler);
    signalHandlers = [];
    // Before the sockets go: a bridged transport outliving the stream
    // it writes to would take every `emitPush` in the process with it.
    stopPushBridge?.();
    stopPushBridge = null;
    pushStream?.close();
    pushStream = null;
    const server = httpServer;
    httpServer = null;
    if (server === null) return Promise.resolve();
    return new Promise((resolveClose) => {
      // Sockets a browser is holding open would otherwise keep this
      // promise pending for as long as the keep-alive lasts.
      server.closeAllConnections();
      server.close(() => resolveClose());
    });
  };

  return {
    // ─── The dialogs, which need somebody to click ───
    //
    // Null and empty are what these members already mean by "nobody
    // chose anything", which is exactly true here and is the only answer
    // their signatures can carry. The sentence goes to the log so that a
    // caller reaching one of these from inside the process leaves a
    // trace — over IPC it never gets this far, because the door refused
    // it first.
    pickDirectory() {
      refuse("open a directory picker");
      return Promise.resolve(null);
    },
    pickFile() {
      refuse("open a file picker");
      return Promise.resolve([]);
    },
    saveFile() {
      refuse("open a save dialog");
      return Promise.resolve(null);
    },

    // ─── The OS, which is not the person's ───
    //
    // `openPath` resolves to the OS's own message when it did not open,
    // and this is that message: the server's filesystem is not the one
    // an admin is looking at, and opening a file on it would put a
    // document on a screen in a datacentre.
    openPath: () => Promise.resolve(refuse("open a file in whatever the OS uses for it")),
    openExternal() {
      refuse("open a browser");
      return Promise.resolve();
    },

    userDataPath: config.userDataPath,

    /**
     * The server's own secret store (EO-320).
     *
     * Where the desktop hands `safeStorage` straight through, this hands
     * AES-256-GCM under a key the operator configured — because there is
     * no keyring on this host to ask, and the design says a server keeps a store of its own rather
     * than going
     * without. Every consumer is unchanged: the interface is the same
     * one, the ciphertext goes in the same `.bin` file beside the
     * database, and `isEncryptionAvailable()` is now true, so the
     * refusals they show a desktop with no keyring do not appear here.
     *
     * Built once, at construction, like `userDataPath` and `version`:
     * the key is a fact about how this process was started, and
     * `readServerConfig` has already refused to start without one.
     */
    keychain: createServerSecretStore(config.secretKey),

    notify({ title, body }) {
      // Logged, which is what a notification is on a host with no
      // desktop. It is not nothing: this is how an operator reading
      // `docker logs` sees that somebody was mentioned.
      console.log(`[eo] notification: ${title} — ${body}`);
    },

    // Nobody is looking at a screen, which is the true answer and the
    // one `view:current` was given this member for.
    hasWindow: () => false,

    // And there is no screen to put the canvas on (EO-383). `canvas:*`
    // is in the machine half and is refused at this process's door
    // before it ever reaches here; the honest `false` is what a caller
    // reaching it some other way gets, rather than a silent success. A
    // browser served this renderer is shown no "Pop out" to press, which
    // is the same answer said where the person can see it.
    openCanvas: () => false,
    hasCanvas: () => false,
    closeCanvas: () => {},

    // Nor one for debug mode (EO-392): `debug:*` is in the machine half
    // and refused at the door, and a server hands no backend anything
    // for the window to show.
    openDebug: () => false,
    isFullScreen: () => false,
    setTitleBarColours: () => false,

    // And nobody's machine is here either (EO-324, ARCHITECTURE.md, "The record"). This process
    // is the record: it owns item state, it runs the only scheduler,
    // and the work happens on the desktops that ask it for some. It has
    // no backend signed in, no worktrees and no person's files, so a
    // device loop here would claim every lease — its record is in the
    // same process and answers first — and then refuse each one at
    // preflight.
    hasMachine: false,

    // Error details never reach a browser. A server is somebody else's
    // machine by definition, and `exposeErrorDetails` is the one place
    // that decision is read.
    isPackaged: true,
    version: config.version,
    resources,

    serveIpc(door) {
      // The door, hung once, onto the same `dispatchIpc` the renderer's
      // `ipcMain` door and the MCP host both call. Created here and bound
      // in `openUserInterface` below, which is exactly the split the two
      // members describe: the handlers are registered by the time this
      // runs, and nothing may arrive until the surface opens.
      // Push is bridged here rather than in `openUserInterface` for the
      // same reason the door is built here: a push that arrives between
      // the handlers coming up and the socket binding has somewhere to
      // go — nowhere, because no client is attached — rather than
      // reaching a transport that does not exist yet.
      const stream = createPushStream();
      pushStream = stream;
      stopPushBridge = bridgePushChannels(stream);

      httpServer = createServer(
        createRequestListener({
          token: config.token,
          rendererDirectory: config.rendererDirectory,
          dispatch: dispatchIpc,
          attachPushStream: (request, response) => stream.attach(request, response),
          // Who else may open this door, besides whoever started the
          // process (EO-323). Absent on a build with no people on it,
          // which is a server that answers to its operator's token
          // alone — exactly what it was between EO-319 and 7b.
          ...(door?.devices === undefined ? {} : { devices: door.devices }),
          // …and what a signed-in device collects from it (EO-328).
          // Absent leaves the route answering 404, which is an honest
          // "this server keeps none" rather than an empty set that would
          // have every device forget what it holds.
          ...(door?.organisationSecrets === undefined ? {} : { organisationSecrets: door.organisationSecrets }),
          // …and where a webhook delivery goes (EO-332, ARCHITECTURE.md, "Webhooks"). Absent
          // leaves `/webhooks/…` answering 404, which is what that
          // address means on a host that is nobody's record.
          ...(door?.webhooks === undefined ? {} : { webhooks: door.webhooks }),
        }),
      );
    },

    openUserInterface() {
      const server = httpServer;
      if (server === null) throw new Error("The server's IPC door was not opened before its surface. This is startMain's order, not a configuration.");
      server.listen(config.port, config.host, () => {
        const bound = server.address();
        const port = typeof bound === "object" && bound !== null ? bound.port : config.port;
        // The token is in the line on purpose. It is the operator's
        // key, and on a server whose people list is empty — which is
        // every server on its first boot — it is the only way to write
        // the first invitation. The same bargain a notebook server
        // makes, and the reason the default bind is loopback.
        console.log(`[eo] server listening on http://${config.host}:${port}/?token=${encodeURIComponent(config.token)}`);
      });
    },

    // Nothing replaces this binary from the inside. A server is updated
    // by whatever installed it — a package manager, a new image — which
    // is precisely the case `loadAutoUpdater` documents `undefined` for.
    loadAutoUpdater: () => Promise.resolve(undefined),

    onBeforeQuit(handler) {
      // The same handler Electron gives `before-quit`, reached the way a
      // server is asked to stop: a signal from whatever is supervising
      // it. `preventDefault` is a no-op rather than a lie — a signal
      // handler that returns has already prevented the default, because
      // Node only ends the process if something tells it to, and what
      // tells it to is `quit()` below.
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const wrapped = (): void => handler({ preventDefault: () => {} });
        process.on(signal, wrapped);
        signalHandlers.push({ signal, handler: wrapped });
      }
    },

    quit() {
      void stopServing().then(() => exitProcess(0));
    },
    exit: (code) => exitProcess(code),

    showErrorBox(title, message) {
      // There is nobody to acknowledge it, so the log is the
      // acknowledgement. Called on exactly one path — a failed migration
      // — where the next line is `exit(1)`, and an operator who sees
      // only the exit code has been told nothing.
      console.error(`[eo] ${title}: ${message}`);
    },

    // "Nobody to ask", which is what null means on this member and what
    // the shutdown coordinator already reads it as: it drains rather
    // than holding the process open for a person who is not there.
    askQuestion: () => Promise.resolve(null),
    // A server does not sleep.
    onWake: () => () => {},
    // So a late watchdog pass here is a paused container or a stalled
    // event loop, not a wake, and holds no watch (EO-514).
    sleeps: false,
    // Nor is it ever held for being offline (EO-457, `Platform.isOnline`).
    isOnline: () => true,

    // Nothing to badge and no window to raise. Silent rather than
    // logged: these two are called on every inbox change and every
    // notification click, and a line each would be noise about a screen
    // that does not exist.
    setBadgeCount: () => {},
    showWindow: () => {},

    address() {
      const bound = httpServer?.address() ?? null;
      return typeof bound === "object" && bound !== null ? { host: config.host, port: bound.port } : null;
    },

    stopServing,
  };
}
