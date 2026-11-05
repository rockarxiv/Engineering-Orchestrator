import type { Db } from "../db/client.js";
import { onMcpConfigChanged, readMcpConfig, toolsFor } from "./gate.js";
import { allowedNamesFor, startListener, type McpListener } from "./http.js";
import { startProtocolHost, type McpProtocolHost } from "./server.js";
import { ensureToken, readTokenValue, type TokenStoreOptions } from "./token.js";

/**
 * EO's MCP server for external clients, as one thing that can be
 * started, stopped and asked how it is doing.
 *
 * It is an accessory and never a dependency. Every path through here
 * that can fail — no keychain, a busy port, an SDK that would not load —
 * ends in a `problem` string and a stopped server, never in a throw that
 * reaches app startup. The original design counted "a backend failed to start
 * error state users will hit" as a real cost of running a server beside
 * the app, and the answer is that this one is not a backend: EO works
 * exactly as it did if it never comes up.
 */
export interface McpHostStatus {
  enabled: boolean;
  dangerousOperations: boolean;
  /** What is configured. */
  port: number;
  /** Where it is actually listening. Null whenever it is not — including when the configured port was taken. */
  listeningPort: number | null;
  /** Whether one has ever been minted. The value itself is `mcpCommands`' business, not this module's. */
  tokenConfigured: boolean;
  /** Why it is not listening, when it should be. Ordinary, not a fault. */
  problem: string | null;
  /** How many tools the current gate exposes, so Settings can say what the switch costs. */
  toolCount: number;
}

export interface McpHostHandle {
  status: () => McpHostStatus;
  /** Applies whatever the config now says: starts, stops, or rebinds. */
  reconcile: () => Promise<McpHostStatus>;
  /**
   * Closes the socket and opens it again on the current configuration.
   *
   * Distinct from `reconcile`, which does nothing when the configuration
   * has not changed. Regenerating the token has to actually drop every
   * open session — they are authenticated on a credential that no longer
   * exists — and that is a restart, not a reconfiguration.
   */
  restart: () => Promise<McpHostStatus>;
  /** Full teardown: closes the socket and stops watching the configuration. Not reusable afterwards. */
  stop: () => Promise<void>;
}

export interface McpHostOptions {
  db: Db;
  version: string;
  tokens: TokenStoreOptions;
}

export function createMcpHost(options: McpHostOptions): McpHostHandle {
  const { db, version, tokens } = options;

  let listener: McpListener | null = null;
  let protocol: McpProtocolHost | null = null;
  let problem: string | null = null;

  function status(): McpHostStatus {
    const config = readMcpConfig(db);
    const token = readTokenValue(tokens);
    return {
      enabled: config.enabled,
      dangerousOperations: config.dangerousOperations,
      port: config.port,
      listeningPort: listener?.port ?? null,
      tokenConfigured: token !== null,
      problem,
      toolCount: toolsFor(config.dangerousOperations).length,
    };
  }

  async function stopListening(): Promise<void> {
    const [openListener, openProtocol] = [listener, protocol];
    listener = null;
    protocol = null;
    // The listener first: stop accepting before tearing down what would
    // answer, so nothing arrives at a half-closed protocol host.
    await openListener?.close();
    await openProtocol?.close();
  }

  async function start(): Promise<void> {
    const config = readMcpConfig(db);

    const token = ensureToken(tokens);
    if (!token.ok) {
      problem = token.reason;
      return;
    }

    const started = await startProtocolHost(db, version, () => allowedNamesFor(listener?.port ?? config.port));
    if (!started.ok) {
      problem = started.problem;
      return;
    }

    const bound = await startListener({ port: config.port, token: token.token, host: started.host });
    if (!bound.ok) {
      await started.host.close();
      problem = bound.problem;
      return;
    }

    protocol = started.host;
    listener = bound.listener;
    problem = null;
  }

  /**
   * Reconciles run one at a time.
   *
   * Two of them start on every settings write: `writeMcpConfig` fires
   * the config listener synchronously, and the IPC handler then awaits
   * one of its own so the status it returns describes a server that has
   * finished moving. Both reach their first `await` before either
   * assigns `listener`, so both see nothing running, both call `start()`,
   * and both bind the same port — one wins and the other records
   * "already in use" over a server that is listening perfectly well.
   * `restart()` can join the same race.
   *
   * Chaining onto the previous attempt is the whole fix. `.then(run, run)`
   * rather than `.then(run)` because a rejected predecessor must not
   * stop the queue — the next caller still has a configuration to apply.
   */
  let queue: Promise<McpHostStatus> = Promise.resolve(status());

  function reconcile(): Promise<McpHostStatus> {
    queue = queue.then(applyConfig, applyConfig);
    return queue;
  }

  async function applyConfig(): Promise<McpHostStatus> {
    const config = readMcpConfig(db);

    if (!config.enabled) {
      await stopListening();
      problem = null;
      return status();
    }

    // A port change while running has to rebind, and a plain restart is
    // clearer than working out which settings can be applied in place.
    if (listener !== null && listener.port === config.port) {
      protocol?.notifyToolsChanged();
      return status();
    }

    await stopListening();
    await start();
    return status();
  }

  // The gate and the port both live in `app_settings`, and whoever
  // writes them knows nothing about this module — they change a setting
  // and this notices, which is what keeps the SDK out of handlers.ts.
  //
  // The subscription is held so `stop` can drop it. In production there
  // is one host for the life of the process and leaking it would never
  // show; in a test suite that builds several, every abandoned host stays
  // subscribed and reconciles against a database that has since closed.
  const unsubscribe = onMcpConfigChanged(() => {
    // Fire-and-forget, so anything thrown here has nowhere to go but an
    // unhandled rejection — which is precisely the "the app broke
    // because of the MCP server" outcome this module exists to prevent.
    // `reconcile` records its own expected failures in `problem`; this
    // catches the unexpected ones and puts them in the same place.
    reconcile().catch((error: unknown) => {
      problem = `The MCP server could not apply its new configuration: ${String(error)}`;
    });
  });

  return {
    status,
    reconcile,
    restart: () => {
      // Queued like everything else, so a token change cannot interleave
      // with a settings change and leave a socket bound with no handle on it.
      queue = queue.then(
        async () => {
          await stopListening();
          return applyConfig();
        },
        async () => {
          await stopListening();
          return applyConfig();
        },
      );
      return queue;
    },
    stop: async () => {
      unsubscribe();
      await stopListening();
    },
  };
}
