import { randomUUID } from "node:crypto";
import { ADMIN_MCP_SERVER_NAME } from "@eo/core";
import type { Db } from "../db/client.js";
import { allowedNamesFor, presentedToken, startListener, type McpListener } from "./http.js";
import { startProtocolHost, type McpProtocolHost } from "./server.js";
import { newToken, tokenMatches } from "./token.js";
import { toolsFor } from "./gate.js";

/**
 * EO's second MCP listener: the whole catalogue, ungated, for EO's own
 * system agent (EO-182).
 *
 * Two servers reach a dispatched agent and they are not
 * interchangeable. `eo` — eoServer.mjs, a child process with a
 * read-only SQLite handle — is eleven read-mostly tools every agent
 * gets, and it has no route back into `dispatchIpc` to grow one. The
 * external host next door has the whole catalogue and is an accessory:
 * off by default, documented as never a dependency, reached by a
 * stranger holding a token out of the keychain. Neither can be
 * stretched into the other, so this is a third thing built out of the
 * second one's parts.
 *
 * **What is different here, and why each difference is safe.**
 *
 * *Ungated, and the only one served the admin-only tools.* `toolsFor(true,
 * "admin")` whatever `mcp.dangerousOperations` says.
 * That switch exists because the external host answers a credential
 * somebody pasted into an editor, and a person who has not thought
 * about it should not have handed out `ticket_delete`. This socket
 * answers a process EO spawned, holding a token EO minted and never
 * wrote down. There is no stranger for the switch to be about.
 *
 * *No file, ever.* The external host's token is in the OS keychain with
 * its ciphertext under `userData`, because a person has to be able to
 * read it and paste it into a client. Nobody pastes this one anywhere:
 * it is minted for a turn, held in this closure, and reaches exactly one
 * place — the environment of the CLI EO spawns, where the generated
 * `.mcp.json`'s `${EO_ADMIN_TOKEN}` expands it. So there is no file to
 * protect, no keychain to be unavailable, and no ciphertext to survive
 * the process that made it.
 *
 * *A credential per turn (EO-444).* Not one token for the life of the
 * listener but one per turn, minted when a turn is about to spawn its
 * CLI and let go of when that turn is over. The reason is the session
 * cap, not secrecy. Every turn is a fresh CLI process that opens a
 * session here, and neither backend's CLI sends DELETE when it exits —
 * so with one token for everything, nothing could tell a dead turn's
 * session from a live one's, each sat out the half-hour idle timeout,
 * and the ninth turn inside that half hour was refused at initialize and
 * ran without this server. The bearer is what every turn already carries
 * on every request, so it is what says which turn a session belongs to;
 * letting a turn's lease go closes its sessions and stops its token
 * working at all.
 *
 * *An ephemeral port.* Nothing is configured to reach this, so nothing
 * needs it to be at a known number, and a fixed one would only be a
 * port to collide with. `startListener` is asked for 0 and answers with
 * what the OS gave; the URL is built from that.
 *
 * What is deliberately **not** different: this dispatches through
 * `ipc/registry.ts` like everything else in this directory, so every
 * write still goes through the handler the renderer calls and invariant
 * #1 holds without this file knowing what `transitionItem` is.
 * `invariants.test.ts` is what keeps that true, and it is why the
 * database handle here is a type and a parameter rather than something
 * this module reaches for.
 */

/**
 * The environment variable the bearer arrives in.
 *
 * One spelling, because two things have to agree about it and they are
 * in different packages: the generated `.mcp.json` writes
 * `Authorization: Bearer ${EO_ADMIN_TOKEN}` and the provider puts the
 * value under that name in the CLI's environment. A mismatch would be a
 * server that starts, advertises nothing, and fails every call with a
 * 401 nobody can see.
 */
export const ADMIN_TOKEN_ENV = "EO_ADMIN_TOKEN";

/**
 * One turn's credential for the internal host (EO-444).
 *
 * Minted per turn, by `AdminMcpEndpoint.lease`, and let go of by whoever
 * spawned the CLI that holds it, once that process is over.
 */
export interface AdminMcpLease {
  /** In memory only — see this module's header on why there is no file. */
  token: string;
  /**
   * Closes every session this token opened and stops it authenticating.
   * Idempotent: a turn that ends twice — a finally after a catch — lets
   * go once.
   */
  release: () => void;
}

/** Where the internal host is, and how to get a credential for it. Null until it is listening. */
export interface AdminMcpEndpoint {
  /** `http://127.0.0.1:<ephemeral>/mcp`. */
  url: string;
  /**
   * A credential for one turn. A function, so that asking where the host
   * is — which writing a generated `.mcp.json` does — mints nothing.
   *
   * `agentId` is the system agent the turn is (EO-585): a result it
   * presses or a reply it posts through this credential is recorded as
   * that agent's, not the person's. A lease taken for no agent acts for
   * the person, as every lease did before.
   */
  lease: (agentId?: string) => AdminMcpLease;
}

export interface AdminMcpStatus {
  listeningPort: number | null;
  /** Why it is not listening. A sentence for the log, never a throw at startup. */
  problem: string | null;
  /** How many tools it serves, which is all of them. */
  toolCount: number;
  /**
   * How many sessions it holds open, against a cap of eight. Each turn's
   * goes when the turn is let go (EO-444), so between turns this is zero.
   */
  openSessions: number;
}

export interface AdminMcpHost {
  /**
   * Binds the socket. Called once, after `registerAllHandlers`, for the
   * reason the external host is: the registry it dispatches through has
   * to be filled before a request can arrive.
   */
  start: () => Promise<AdminMcpStatus>;
  status: () => AdminMcpStatus;
  /**
   * What to write into an agent's generated configuration, or null when
   * the host is not up.
   *
   * Asked per dispatch rather than captured, so a dispatch that happens
   * before the socket is bound — or after a start that failed — delivers
   * no entry at all rather than one pointing at nothing. An agent given
   * a server that cannot answer is worse off than one given none: the
   * first spends its turn on connection errors, the second reads its
   * prompt and says what it cannot do.
   */
  endpoint: () => AdminMcpEndpoint | null;
  stop: () => Promise<void>;
}

export interface AdminMcpOptions {
  db: Db;
  version: string;
  /**
   * Calls this server refuses before running them (EO-356) — see
   * `ProtocolHostOptions.refuseCall`. Handed in by the composition root,
   * because the rules read EO's state and this directory does not.
   */
  refuseCall?: (tool: string, args: unknown) => string | null;
  /**
   * Told of every call this server answered (EO-501) — see
   * `ProtocolHostOptions.observeCall`. Handed in by the composition root
   * for `refuseCall`'s reason.
   */
  observeCall?: (tool: string, args: unknown, data: unknown) => void;
}

export function createAdminMcpHost(options: AdminMcpOptions): AdminMcpHost {
  const { db, version, refuseCall, observeCall } = options;

  let listener: McpListener | null = null;
  let protocol: McpProtocolHost | null = null;
  let problem: string | null = null;
  /**
   * The tokens currently out, each to the owner its sessions are filed
   * under. The only copies in the process, and emptied when the host
   * stops.
   */
  const leases = new Map<string, string>();
  /**
   * Which system agent each owner is, for the turns leased for one
   * (EO-585). Gone with the lease, by which time the token no longer
   * authenticates and no call can arrive to ask.
   */
  const agents = new Map<string, string>();

  /** Constant-time per token: a lookup's timing would otherwise say how much of a guess was right. */
  function current(presented: string): boolean {
    let found = false;
    for (const token of leases.keys()) if (tokenMatches(token, presented)) found = true;
    return found;
  }

  function lease(agentId?: string): AdminMcpLease {
    const token = newToken();
    const owner = randomUUID();
    leases.set(token, owner);
    if (agentId !== undefined) agents.set(owner, agentId);
    return {
      token,
      release: () => {
        if (!leases.delete(token)) return;
        agents.delete(owner);
        void protocol?.closeSessionsOf(owner);
      },
    };
  }

  function status(): AdminMcpStatus {
    return { listeningPort: listener?.port ?? null, problem, toolCount: toolsFor(true, "admin").length, openSessions: protocol?.sessionCount() ?? 0 };
  }

  return {
    status,

    start: async () => {
      if (listener !== null) return status();

      const started = await startProtocolHost(db, version, () => allowedNamesFor(listener?.port ?? 0), {
        name: ADMIN_MCP_SERVER_NAME,
        // The whole reason `view_current` can exist at all (EO-192).
        // Everything else here is served to the external listener too;
        // an admin-only tool is one this socket has and that one does
        // not, and saying so is what makes that true rather than hoped.
        audience: "admin",
        // The whole of the difference. Not `readMcpConfig(db)` and not a
        // second setting — a constant, so there is no state in which
        // this server serves less than the catalogue.
        dangerousOperations: () => true,
        ...(refuseCall ? { refuseCall } : {}),
        ...(observeCall ? { observeCall } : {}),
        // Which turn a session is, by the bearer it was opened with — so
        // that turn's sessions can be closed when its process is over
        // (EO-444). Null once the lease is let go, which is what tells the
        // protocol host a handshake in flight belongs to nobody any more.
        sessionOwner: (req) => {
          const presented = presentedToken(req);
          return presented === null ? null : (leases.get(presented) ?? null);
        },
        // And which system agent that turn is (EO-585), so a press or a
        // reply made through it is recorded as the agent's own.
        actingAgent: (owner) => agents.get(owner) ?? null,
      });
      if (!started.ok) {
        problem = started.problem;
        return status();
      }

      // Port 0: the OS picks. See the header — nothing is configured to
      // reach this, so there is nothing for a fixed number to buy.
      const bound = await startListener({ port: 0, token: current, host: started.host });
      if (!bound.ok) {
        await started.host.close();
        problem = bound.problem;
        return status();
      }

      protocol = started.host;
      listener = bound.listener;
      problem = null;
      return status();
    },

    endpoint: () => {
      if (listener === null) return null;
      return { url: `http://127.0.0.1:${listener.port}/mcp`, lease };
    },

    stop: async () => {
      const [openListener, openProtocol] = [listener, protocol];
      listener = null;
      protocol = null;
      // Dropped here as well as on the way out of the process. The
      // socket is closing, so the credentials are worth nothing — but a
      // token that lingers in a closure after the thing it authenticated
      // is gone is a copy nobody is thinking about any more.
      leases.clear();
      agents.clear();
      // The listener first, so nothing arrives at a half-closed protocol
      // host — the order `mcpHost/index.ts` closes in, for the same reason.
      await openListener?.close();
      await openProtocol?.close();
    },
  };
}
