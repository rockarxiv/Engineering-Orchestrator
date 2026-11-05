import { adminToolsEnabled, type Agent } from "@eo/core";
import { ADMIN_TOKEN_ENV, type AdminMcpEndpoint } from "../mcpHost/admin.js";

/**
 * Whether this dispatch delivers EO's administrative server, and with
 * what (EO-182).
 *
 * Its own module because the decision has two halves that live nowhere
 * near each other and must not be made twice. The **grant** is a
 * question about `allowedTools`, answered by `adminToolsEnabled` in
 * `packages/core`. The **host** is a question about a socket, answered
 * by a listener started in `index.ts` after the IPC registry is filled.
 * The generated directory needs the first and the URL; the CLI's
 * environment needs the first and the token. Two readers that could
 * disagree would be a `.mcp.json` naming a server whose bearer never
 * arrives — a 401 on every call, from a server that connected.
 *
 * Where the token goes is the whole reason these are separate returns.
 * `AdminMcpDelivery` is what reaches disk or a command line and carries a
 * variable *name*; `AdminMcpDispatch.environment` is what reaches the
 * child process and carries the value. That is the same arrangement every attached
 * server's secret travels under, and the reason no file EO generates has
 * ever held one.
 *
 * **Two backends read this, not one (EO-203).** Claude is handed the
 * delivery as a `.mcp.json` entry in its generated tool directory; Codex
 * has no such directory and is handed the same fact as an `mcp_servers`
 * entry built in `providers/codex.ts`. What used to be shaped like "what
 * to write into the generated file" is therefore shaped like "where the
 * server is and what its credential is called", and the backend decides
 * the spelling. `adminDispatchFor` is what both of them ask at spawn
 * for the bearer — Codex for its configuration as well, which it
 * assembles in the same breath.
 *
 * **A bearer per turn (EO-444).** The value under that name is minted
 * for the turn that asks and let go of when that turn's process is over
 * — see `mcpHost/admin.ts` on why. The URL is not a credential and asking
 * for it mints nothing, which is why the generated file is written from
 * `adminDeliveryFor` and the bearer comes only from `adminDispatchFor`.
 */

/**
 * Where EO's administrative server is, and the name of the variable its
 * bearer arrives in.
 *
 * Homed here rather than beside the generated directory that used to be
 * its only reader (EO-203). The `.mcp.json` layout is Claude's and the
 * `mcp_servers` object is Codex's; a loopback URL and the name of a
 * variable are neither's, so the fact lives in the module that decides
 * whether there is one at all.
 *
 * **The token is not in this type on purpose.** Nothing that reaches
 * disk or a command line needs it, and a field holding it here would be
 * a value one careless `JSON.stringify` away from a file under
 * `userData` — or, on the Codex path, from `/proc/<pid>/cmdline`, where
 * everything under `config` ends up.
 */
export interface AdminMcpDelivery {
  /** Where the internal host is listening: `http://127.0.0.1:<port>/mcp`. */
  url: string;
  /** The environment variable the bearer arrives in, referenced by name and never by value. */
  envName: string;
}

/**
 * Both halves of one dispatch, resolved together (EO-203).
 *
 * For the backend that has no generated directory to write and so builds
 * its configuration and its environment in one function: Codex names the
 * variable in `mcp_servers.<name>.bearer_token_env_var` and reads the
 * value out of the environment the SDK is given, and both are assembled
 * inside `buildCodexOptions`. And, since EO-444, for Claude too, which
 * takes only the environment from it — the URL went into its `.mcp.json`
 * a dispatch earlier — because the bearer is now one turn's, and the
 * `release` beside it has to reach the adapter that knows when the turn
 * is over.
 *
 * One return rather than two calls, because the URL and the token belong
 * to the *same* listener. Asking twice would let a host restarted between
 * the two answers hand a CLI one listener's address and another's
 * credential — the 401-from-a-server-that-connected this module's header
 * is about, and the one failure a split makes possible here that it does
 * not make possible on the Claude path, where the two halves are already
 * a dispatch apart.
 */
export interface AdminMcpDispatch {
  /** What the CLI is configured with — no value of any kind. */
  server: AdminMcpDelivery;
  /** The bearer, in the shape the CLI's environment takes it. */
  environment: Record<string, string>;
  /**
   * Lets the bearer go once the CLI it was spawned into is over (EO-444):
   * the host closes the sessions it opened, which no CLI does for itself
   * on exit, and stops accepting it. Every adapter that asks for one of
   * these calls this when its turn ends, however it ended — a turn that
   * does not is a session held against the host's cap for half an hour.
   */
  release: () => void;
}

/**
 * Where the internal host is, asked per dispatch.
 *
 * Undefined is what a caller with no host at all passes — the v1 gate,
 * every test that is not about this — and null is what a host that has
 * not bound yet answers. Both mean the same thing here and neither is a
 * failure: the agent is dispatched without the entry, which is exactly
 * what an agent holding no grant gets.
 */
export type AdminMcpLookup = (() => AdminMcpEndpoint | null) | undefined;

function endpointFor(agent: Pick<Agent, "config">, lookup: AdminMcpLookup): AdminMcpEndpoint | null {
  if (!adminToolsEnabled(agent)) return null;
  return lookup?.() ?? null;
}

/** One spelling of the address, so the two readers below cannot drift apart. */
function deliveryOf(endpoint: AdminMcpEndpoint): AdminMcpDelivery {
  return { url: endpoint.url, envName: ADMIN_TOKEN_ENV };
}

/**
 * What to write into this agent's generated `.mcp.json`, or null.
 *
 * Null rather than an entry when the host is down, deliberately. An
 * agent handed a server that cannot answer spends its turn on connection
 * errors; an agent handed nothing reads its prompt and says plainly what
 * it cannot do, which is the more useful of the two failures.
 */
export function adminDeliveryFor(agent: Pick<Agent, "config">, lookup: AdminMcpLookup): AdminMcpDelivery | null {
  const endpoint = endpointFor(agent, lookup);
  return endpoint === null ? null : deliveryOf(endpoint);
}

/**
 * The configuration entry and the credential for it, off one reading of
 * the host (EO-203).
 *
 * Null on the same terms as `adminDeliveryFor`: no grant, or no host to
 * point at. A backend given this delivers both halves or neither, which
 * is the only pair of outcomes that is not a 401 nobody can see.
 */
export function adminDispatchFor(agent: Pick<Agent, "config"> & Partial<Pick<Agent, "id">>, lookup: AdminMcpLookup): AdminMcpDispatch | null {
  const endpoint = endpointFor(agent, lookup);
  if (endpoint === null) return null;
  // Leased for this agent (EO-585), so what it presses or replies through
  // the credential is recorded as its own and not as the person's. Here,
  // where both backends ask, so neither can come to act as the person.
  const lease = endpoint.lease(agent.id);
  return { server: deliveryOf(endpoint), environment: { [ADMIN_TOKEN_ENV]: lease.token }, release: lease.release };
}
