import { NO_POLICY, personBudgetAcross, type IpcPayload, type IpcResponse, type OrganisationPolicy, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { actingCaller } from "../identity/acting.js";
import { signedInPersonId } from "../identity/viewer.js";
import type { ManagedDirectory } from "../managed/directory.js";
import {
  clearOrganisationSecret,
  listOrganisationSecretNames,
  storeOrganisationSecret,
  type OrganisationSecretsOptions,
} from "../policy/organisationSecrets.js";
import { personBudgetFor, readPolicy, writePolicy } from "../policy/policy.js";

/**
 * Policy, as channels (EO-328, `ARCHITECTURE.md`, "Policy",
 * "Secrets").
 *
 * The rule that decides where each of these *runs* is the one
 * `identityCommands.ts` already states and this file follows without
 * restating: **the record owns the list, and a desktop's action on it is
 * a command the record applies.** So on a desktop signed in to an
 * organisation the three writes go to the server; on a solo desktop, and
 * on the server itself, they are answered here.
 *
 * `policy:get` is the read, and it falls back — a server that cannot be
 * reached leaves the desktop on its last published copy and says
 * `fromServer: false`, which is the original design ("managed mode never stops a person
 * from working") rather than an error dialog over the board.
 *
 * ## Nothing here writes the desktop's cached copy
 *
 * `policy/sync.ts` owns it, and that is a rule rather than a division of
 * labour. Caching here as well would put two writers on one row, and the
 * one that matters is the second: the sync reads the *previous* published
 * set to decide which catalogue rows an organisation has stopped
 * publishing, so a read that had already overwritten it would leave a
 * withdrawn MCP server installed for ever. So a screen is answered with
 * the record's policy and the guards go on reading the copy the last sync
 * wrote — at most one tick behind, which is the same lag every other
 * published thing has.
 *
 * ## The value never comes back
 *
 * `policy:setSecret` takes a value; nothing in this file hands one out,
 * and `listOrganisationSecretNames` is the only thing that ever touches
 * the store on the read side. That is the story's third acceptance
 * criterion made structural rather than remembered: a desktop is given
 * the values by `server/http.ts`'s own route, which is not a channel, so
 * no query the renderer can make has anywhere to return one from.
 */

export interface PolicyContext {
  /** How this installation reaches its organisation, when it has one. Absent on a server. */
  managed?: ManagedDirectory;
  /**
   * Where this process keeps organisation secret values.
   *
   * On a **server** this is the store the admin's `policy:setSecret`
   * writes into and the route reads back out of. On a **desktop** it is
   * the copy `policy/sync.ts` fills, and these handlers never write it —
   * a desktop's writes are forwarded to the record.
   */
  secrets: OrganisationSecretsOptions;
}

/**
 * What the organisation allows, and what today has cost the caller.
 *
 * The policy comes from the server when this desktop is signed in to
 * one, and from this process's own row otherwise — but a pull is also a
 * *write*: what comes back is cached, so the next dispatch and the next
 * render have it without a network call, and so a desktop that goes
 * offline an hour from now is still on the policy its organisation
 * published. `sync.ts` does the same on the tick; this does it on the
 * read, because a screen somebody just opened should not be showing an
 * hour-old ceiling when the server is right there.
 *
 * ## The budget line is the *person's*, not the machine's
 *
 * the design's ceiling is per person and a person has more than one machine,
 * so the line has to read what the dispatch guard reads — and the guard
 * takes the larger of the record's total and this replica's, because
 * each is short in a different direction (`personBudgetAcross` argues
 * it). This used to compute the line from local rows alone while
 * *fetching* and discarding the record's answer, which produced exactly
 * the disagreement the whole arrangement exists to prevent: Anna spends
 * her day on desktop A, desktop B correctly parks her next item, and
 * desktop B's top bar says "your budget: $0 of $10 today" until
 * replication catches up.
 *
 * So both readings are combined, through the same function the guard
 * uses. A record that could not be reached leaves the replica's figure
 * standing, which is the permissive direction and the design's rule.
 */
export async function getPolicyCommand(db: Db, context: PolicyContext, payload?: IpcPayload<"policy:get">): Promise<IpcResponse<"policy:get">> {
  const client = context.managed?.client() ?? null;
  const fromRecord = client === null ? null : await client.request("policy:get", payload ?? {});
  // The record's answer where there is one, and the copy this machine
  // kept where the record could not be reached (ARCHITECTURE.md, "The record").
  const policy = fromRecord?.ok === true ? fromRecord.data.policy : readPolicy(db);

  // The record's figure for *this* person: `policy:get` is actor-scoped,
  // so the door stamped the asking device onto the request and the
  // record resolved it to whoever this machine is signed in as. Null
  // where the record was not asked, could not be reached, or publishes
  // no ceiling at all.
  const onTheRecord = fromRecord?.ok === true ? fromRecord.data.yours : null;
  const here = personBudgetFor(db, policy, whoIsAsking(db, payload?.actingDeviceId));
  const budgetCents = here?.budgetCents ?? onTheRecord?.budgetCents ?? null;

  const caller = actingCaller(db, payload?.actingDeviceId);
  return {
    policy,
    fromServer: fromRecord?.ok === true,
    // Whether this caller may publish, *here* (ARCHITECTURE.md, "Publish, lock and versions",
    // review).
    //
    // `fromServer` was doing this job and inverted the two surfaces: the
    // admin's browser is served by the record, so it has no managed
    // client and read false, while every managed desktop read true and
    // was offered a Publish button for a section the design says is edited on
    // the server.
    //
    // All three conditions, and each rules out a different surface.
    // `client === null` is "this process is the record" — a managed
    // desktop has one and is therefore reading rather than writing.
    // `caller.served` is "a door was crossed", which is what tells the
    // admin's browser from a laptop window and is what keeps a solo
    // desktop — whose one person may carry the admin flag perfectly
    // well — from being offered a Publish with nobody to publish to.
    // `caller.admin` is the design's one flag, which is what the door itself
    // refuses `policy:save` on, so this is the screen agreeing with the
    // door rather than guessing ahead of it.
    mayPublish: client === null && caller.served && caller.admin,
    // Both readings, through the function the dispatch guard uses, so
    // the line and the guard cannot come to different answers about the
    // same day.
    yours:
      budgetCents === null
        ? null
        : personBudgetAcross(budgetCents, [onTheRecord?.spentCents ?? 0, here?.spentCents ?? 0]),
  };
}

/**
 * Publishes the policy section.
 *
 * The secret names are not taken from the request and are not the
 * caller's to send: they are what this record's own store actually
 * holds, read back on every save. A published name with no value behind
 * it would have every desktop draw "set by your organisation" beside a
 * variable no run will ever be given, which is the one kind of lie this
 * section cannot afford.
 */
export async function savePolicyCommand(db: Db, context: PolicyContext, input: IpcPayload<"policy:save">): Promise<IpcResponse<"policy:save">> {
  const client = context.managed?.client() ?? null;
  if (client !== null) {
    const answer = await client.request("policy:save", input);
    // The record's own answer, including its refusals — and its policy,
    // which the screen redraws from. This machine's *cached* copy is
    // left to the next sync, for the reason at the top of this file.
    return answer.ok ? answer.data : { saved: false, policy: readPolicy(db), problem: answer.error.message };
  }

  const policy: OrganisationPolicy = {
    ...NO_POLICY,
    allowedBackends: input.allowedBackends,
    perPersonDailyBudgetCents: input.perPersonDailyBudgetCents,
    mcpServers: input.mcpServers,
    secretNames: listOrganisationSecretNames(context.secrets),
    publishedAt: Date.now(),
    publishedBy: whoIsAsking(db, input.actingDeviceId),
  };
  writePolicy(db, policy);
  return { saved: true, policy, problem: null };
}

export async function setPolicySecretCommand(
  db: Db,
  context: PolicyContext,
  input: IpcPayload<"policy:setSecret">,
): Promise<IpcResponse<"policy:setSecret">> {
  const client = context.managed?.client() ?? null;
  if (client !== null) {
    const answer = await client.request("policy:setSecret", input);
    return answer.ok ? answer.data : { saved: false, problem: answer.error.message };
  }

  const result = storeOrganisationSecret(context.secrets, input.name, input.value);
  if (!result.ok) return { saved: false, problem: result.reason };
  republishNames(db, context, whoIsAsking(db, input.actingDeviceId));
  return { saved: true, problem: null };
}

export async function clearPolicySecretCommand(
  db: Db,
  context: PolicyContext,
  input: IpcPayload<"policy:clearSecret">,
): Promise<IpcResponse<"policy:clearSecret">> {
  const client = context.managed?.client() ?? null;
  if (client !== null) {
    const answer = await client.request("policy:clearSecret", input);
    return answer.ok ? answer.data : { cleared: false, problem: answer.error.message };
  }

  clearOrganisationSecret(context.secrets, input.name);
  republishNames(db, context, whoIsAsking(db, input.actingDeviceId));
  return { cleared: true, problem: null };
}

/**
 * Keeps the published names and the record's own store the same set.
 *
 * Called by both secret writes and by neither of the desktop paths,
 * because a desktop holds a copy rather than the record. `publishedAt`
 * is touched too: adding a secret *is* a publish as far as a device is
 * concerned — it changes what every desktop is to be given — and a
 * device that compared timestamps to decide whether to re-sync would
 * otherwise never learn about it.
 */
function republishNames(db: Db, context: PolicyContext, by: string | null): void {
  const policy = readPolicy(db);
  writePolicy(db, {
    ...policy,
    secretNames: listOrganisationSecretNames(context.secrets),
    publishedAt: Date.now(),
    publishedBy: by,
  });
}

/**
 * Whose request this is, by person id.
 *
 * Two readings, and whether the field is *there at all* is what tells
 * them apart — which is `identity/acting.ts`'s own first case. An absent
 * `actingDeviceId` is a request that crossed no door: a desktop, where
 * the honest answer is whoever this machine signed in as. `actingCaller`
 * would answer the implicit local person, who on a signed-in desktop
 * owns none of the projects whose spend is being asked about.
 *
 * A field that is present — an id, or the operator's null — was stamped
 * by a door that knows who authenticated, and that is a fact rather than
 * a claim.
 *
 * Null for the operator's key, which administers an organisation without
 * being a member of one — there is no person to have a budget, and
 * `publishedBy` records that honestly rather than naming somebody.
 */
function whoIsAsking(db: Db, actingDeviceId: string | null | undefined): Uuid | null {
  if (actingDeviceId === undefined) return signedInPersonId(db);
  return (actingCaller(db, actingDeviceId).person?.id as Uuid | undefined) ?? null;
}
