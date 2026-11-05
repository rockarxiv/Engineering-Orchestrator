import { managedServerIds, ORGANISATION_SECRETS_PATH, type OrganisationPolicy } from "@eo/core";
import type { Db } from "../db/client.js";
import { applyPublishedMcpServers, type PublishedServersResult } from "../db/repos/mcpServersRepo.js";
import type { ServerClient } from "../managed/serverClient.js";
import {
  clearOrganisationSecret,
  listOrganisationSecretNames,
  replaceOrganisationSecrets,
  type OrganisationSecretsOptions,
} from "./organisationSecrets.js";
import { readPolicy, writePolicy } from "./policy.js";

/**
 * Taking the organisation's policy, and the values behind it (EO-328,
 * `ARCHITECTURE.md`, "Policy", "The record").
 *
 * The third thing a device does on a tick, after saying what it did and
 * taking what the record has. It is not folded into `drain.ts` because
 * it is not the same kind of traffic: a drain moves rows both ways and
 * is paged and cursored, while this replaces one cached value and one
 * set of files — re-doing it from scratch costs nothing and loses
 * nothing, so there is no cursor to keep and no order to preserve.
 *
 * ## Two fetches, and only one of them is a channel
 *
 * The policy comes over `policy:get`, because it is the record half of
 * the contract and every client already has a typed way to ask for it.
 * The **values** come over `ORGANISATION_SECRETS_PATH`, which is not a
 * channel at all — see that constant, and `ipcLeak.test.ts`, for why the
 * separation is this story's third acceptance criterion rather than a
 * stylistic choice.
 *
 * ## Nothing here fails loudly
 *
 * the original design: "managed mode never stops a person from working." A server that
 * cannot be reached leaves this machine on the copy it already had —
 * which is the whole reason there is a copy — and the sync line beside
 * the board already says how long it has been out of touch. A refusal
 * here would be a second, louder sentence about one outage.
 *
 * The one thing that is **not** deferred is a withdrawal. Once the
 * record has said what it publishes, a name that has left the list is
 * removed from this machine on this pass, whether or not the values
 * arrive afterwards: taking a credential away is the half of this that
 * must not wait for a good network.
 */

export interface PolicySyncOptions {
  db: Db;
  /**
   * How this device reaches the record, asked afresh each time.
   *
   * A function for `ManagedDirectory`'s reason: the sign-in changes
   * under this, and a client captured at startup would go on carrying a
   * token somebody signed out of until the app restarted. Null is a solo
   * desktop, a signed-out one, and the record itself — which has nobody
   * to ask.
   */
  client: () => ServerClient | null;
  secrets: OrganisationSecretsOptions;
  /**
   * This device's **organisation-secrets key**, for the one request that
   * does not go through `ServerClient` (EO-328, ARCHITECTURE.md, "Secrets").
   *
   * Not the device token, and that is the point rather than a detail:
   * the token is what a renderer holds, and a route the token opened
   * would be a route the browser a server serves could call. This is the
   * second credential, minted only for a client that signed in saying it
   * runs work, kept in the OS keychain and handed to no window.
   *
   * A function rather than a value, for `ManagedDirectory`'s reason: it
   * changes under this — a sign-in, a sign-out, a revocation met by
   * another request — and a closure that captured it would carry a stale
   * one until the app restarted.
   *
   * Null is a device that collects no organisation secrets: a desktop
   * signed in to a server too old to mint one, or one whose key was
   * withdrawn. It keeps whatever it already holds and asks for nothing.
   */
  secretsKey: () => string | null;
  /** `globalThis.fetch` in production. A test passes its own rather than opening a socket. */
  fetch?: typeof globalThis.fetch;
  /**
   * Where a pass says what it could not do, for the log.
   *
   * `console.warn` in production. It is **not** how a person learns
   * about it, and that was the mistake a review caught: a refused
   * publish reached a process log and nowhere else, so the catalogue
   * showed the person's own `github`, said nothing about the
   * organisation's, and the first evidence was an agent reporting a tool
   * it had never been given. `mcpServers:list` carries `unavailable`
   * now, derived on every read, and the Agent Tools screen draws it.
   *
   * This survives as an operator's line — a server admin reading
   * `docker logs` has no screen — and as the thing a test can watch
   * without a renderer.
   */
  onProblem?: (line: string) => void;
}

export interface PolicySyncResult {
  /** Whether the record answered at all. False on a solo desktop, and on an offline one. */
  reached: boolean;
  /**
   * Whether what came back differs from what this machine was on.
   *
   * What the caller pushes on, so that an admin publishing reaches a
   * window somebody has open rather than waiting for them to click
   * something. False on the ordinary pass, which is nearly all of them —
   * a push a minute, every minute, on every desktop, for a policy nobody
   * changed would be EO reporting its own timer.
   */
  changed: boolean;
  /** What this machine is on now — the record's, or the copy it kept. */
  policy: OrganisationPolicy;
  /**
   * Names the organisation publishes and this machine has no value for.
   *
   * A published name with nothing behind it is what a run meets as an
   * unset variable, so it is worth being able to say — and it is not an
   * error: a device that has just signed in has every one of them until
   * its first successful value fetch.
   */
  unresolved: string[];
  /**
   * What became of the published MCP server definitions on this
   * machine — taken, refused for a name collision, or archived because
   * the organisation stopped publishing them.
   *
   * Refusals are worth carrying out of here rather than swallowing: "your
   * organisation publishes a server this machine could not install"
   * is a sentence somebody has to be able to read (invariant #12 —
   * an absence is never left to be discovered by an agent).
   */
  servers: PublishedServersResult;
}

/** A pass that never got as far as asking. */
const NOTHING_APPLIED: PublishedServersResult = { applied: [], refused: [], withdrawn: [] };

export async function syncPolicy(options: PolicySyncOptions): Promise<PolicySyncResult> {
  const { db, secrets } = options;
  const client = options.client();
  if (client === null) return { reached: false, changed: false, policy: readPolicy(db), unresolved: [], servers: NOTHING_APPLIED };

  const answer = await client.request("policy:get", {});
  if (!answer.ok) return { reached: false, changed: false, policy: readPolicy(db), unresolved: [], servers: NOTHING_APPLIED };

  const policy = answer.data.policy;
  const held = readPolicy(db);
  // Compared whole, by value, rather than on `publishedAt`: an admin who
  // publishes twice in the same millisecond is a curiosity, and a
  // timestamp comparison that missed the second of them would be a
  // desktop on a policy nobody can see it is on.
  const changed = JSON.stringify(held) !== JSON.stringify(policy);
  // The previous publish, read before it is overwritten: it is how
  // `applyPublishedMcpServers` knows which catalogue rows came from an
  // organisation and may therefore be archived when one leaves the list.
  const before = managedServerIds(held);
  writePolicy(db, policy);

  // The definitions, into this machine's own catalogue (ARCHITECTURE.md, "Policy"). Written
  // there rather than kept beside it so that every consumer downstream —
  // the attachment picker, the generated configuration, the dispatch's
  // account of what an agent was served — works unchanged.
  const servers = applyPublishedMcpServers(db, policy.mcpServers, before);
  for (const problem of servers.refused) options.onProblem?.(problem.problem);

  // What the organisation has stopped publishing goes now, before
  // anything can fail. `replaceOrganisationSecrets` would do this too,
  // and does not get the chance on the path where the values never
  // arrive.
  const published = new Set(policy.secretNames);
  for (const name of listOrganisationSecretNames(secrets)) {
    if (!published.has(name)) clearOrganisationSecret(secrets, name);
  }

  // An organisation that publishes no secrets never asks for the route
  // at all: the withdrawal above has already emptied the store.
  if (policy.secretNames.length === 0) return { reached: true, changed, policy, unresolved: [], servers };

  const values = await fetchValues(options, client);
  if (values === null) {
    // The record said what it publishes and would not say what is
    // behind it. Whatever this machine already holds stands — it is the
    // last good copy — and what it does not hold is reported.
    const heldNames = new Set(listOrganisationSecretNames(secrets));
    return { reached: true, changed, policy, unresolved: policy.secretNames.filter((name) => !heldNames.has(name)).sort(), servers };
  }

  const { refused } = replaceOrganisationSecrets(secrets, values);
  // A name the policy published and the record then declined to say —
  // an admin clearing it between the two requests, or a value its own
  // store could not read. Reported rather than stored empty: a variable
  // set to nothing at all is a credential that is present and wrong,
  // which is worse to a server than one that is simply missing.
  const missing = policy.secretNames.filter((name) => !Object.hasOwn(values, name));
  return { reached: true, changed, policy, unresolved: [...new Set([...refused, ...missing])].sort(), servers };
}

/**
 * The values, or null for "this pass learned nothing about them".
 *
 * Null covers an offline desktop, a TLS failure, a proxy answering HTML,
 * a server too old to have the route and a device holding no secrets key
 * — one answer, because the caller does the same thing with all five:
 * keeps what it has.
 */
async function fetchValues(options: PolicySyncOptions, client: ServerClient): Promise<Record<string, string> | null> {
  const key = options.secretsKey();
  if (key === null) return null;
  const doFetch = options.fetch ?? globalThis.fetch;
  try {
    const response = await doFetch(`${client.address}${ORGANISATION_SECRETS_PATH}`, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const secrets = (body as { secrets?: unknown } | null)?.secrets;
    if (secrets === null || typeof secrets !== "object") return null;
    const values: Record<string, string> = {};
    // Filtered rather than cast: this crosses a network, and a member
    // that is not a string is a server saying something this build does
    // not understand rather than a value to write to disk.
    for (const [name, value] of Object.entries(secrets as Record<string, unknown>)) {
      if (typeof value === "string") values[name] = value;
    }
    return values;
  } catch {
    return null;
  }
}

/**
 * How often a tick is allowed to ask.
 *
 * The engine ticks far more often than an organisation publishes, and
 * unlike `drainToRecord` — which has work to do on most ticks and a
 * cursor that makes an empty pass nearly free — this pass fetches the
 * whole policy and, where there are any, every secret value. Once a
 * minute is well inside "a desktop learns about a publish promptly" and
 * well outside "a laptop asks a server for a list of credentials every
 * few seconds".
 *
 * It is a floor on *asking*, not a staleness bound on what a dispatch
 * reads: the guards read the cached copy, which is whatever the last
 * successful pass wrote.
 */
export const POLICY_SYNC_INTERVAL_MS = 60_000;

/**
 * Why a pass is happening (EO-328, review).
 *
 * `polling` is the engine's tick, which comes round every few seconds
 * and is rate-limited: an admin does not publish twice a minute, and a
 * laptop asking a server for a list of credentials every few seconds is
 * the thing `POLICY_SYNC_INTERVAL_MS` exists to stop.
 *
 * `published` is the record saying *this changed*, which is not a poll
 * at all. It arrives once, because something happened, and rate-limiting
 * it was the bug: a `config:changed` that landed inside the interval was
 * dropped, so an admin who disallowed a backend watched a device go on
 * dispatching to it for up to a minute — the acceptance criterion says
 * a device bound to a disallowed backend *cannot dispatch*, not that it
 * stops within the minute.
 *
 * The distinction is the reason this is a word rather than a boolean:
 * "force" reads as an escape hatch, and this is the ordinary handling of
 * a different kind of event.
 */
export type PolicySyncReason = "polling" | "published";

/**
 * `syncPolicy` with the tick's rate limit around it — and a way past it
 * for the one event that is not a poll.
 *
 * Returns null when the call was skipped, which is most of them, so a
 * caller can tell "nothing was asked" from "nothing had changed" — and
 * so a test can assert the skip rather than infer it from a fetch count.
 *
 * The clock is captured *before* the await and the next pass is allowed
 * from then, so a slow or hanging request does not extend the interval
 * behind it. Overlapping polls are prevented by the same stamp: the
 * second is inside the interval and is skipped.
 *
 * A `published` pass **also stamps the clock**, which is what keeps the
 * two from fighting: a push and a tick arriving together are one pass,
 * and the rate limit resumes from whichever of them ran.
 */
export function createPolicySync(
  options: PolicySyncOptions & { minIntervalMs?: number; now?: () => number },
): (reason?: PolicySyncReason) => Promise<PolicySyncResult | null> {
  const interval = options.minIntervalMs ?? POLICY_SYNC_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let last: number | null = null;
  return async (reason: PolicySyncReason = "polling") => {
    const at = now();
    if (reason === "polling" && last !== null && at - last < interval) return null;
    last = at;
    return syncPolicy(options);
  };
}
