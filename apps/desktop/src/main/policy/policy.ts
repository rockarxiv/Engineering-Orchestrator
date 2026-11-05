import {
  NO_POLICY,
  OrganisationPolicySchema,
  overPersonBudget,
  type OrganisationPolicy,
  type PersonBudget,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { clearSetting, getSetting, setSetting } from "../db/repos/settingsRepo.js";
import { personCostCentsSince } from "../db/repos/runsRepo.js";
import { startOfDay } from "../dateUtils.js";
import { signedInPersonId } from "../identity/viewer.js";
import { ownerOfItem } from "./personBudget.js";

/**
 * The policy in force on this process (EO-328,
 * `ARCHITECTURE.md`, "Policy").
 *
 * One row in `app_settings`, and which process wrote it is the whole of
 * the difference between the two topologies:
 *
 *  - on an **organisation server** it is what the admin published, and
 *    this process is the only writer of it;
 *  - on a **signed-in desktop** it is the last copy pulled from that
 *    server (`sync.ts`), kept so that the original design holds — "the desktop keeps
 *    working on its last published version" — and so that a dispatch
 *    can ask the question without a network round trip in front of it;
 *  - on a **solo desktop** it is never written at all, and every reader
 *    gets `NO_POLICY`.
 *
 * `app_settings` rather than a table because it is exactly one value of
 * exactly one shape, which is what that table is for (the guardrails
 * live there for the same reason) — and because a desktop's copy is a
 * cache rather than a record, so nothing is owed a history.
 *
 * **Parsed rather than cast on every read.** This value is written by
 * one version of EO and read by another: a desktop pulls a policy from a
 * server that may be a release ahead of it, and a field that arrived in
 * a shape this build cannot read must not be able to throw inside a
 * dispatch. An unreadable copy reads as "the organisation has not said",
 * which is the safe direction — a policy that could fail closed would
 * stop every run on the machine on the strength of a parse error.
 */

export const POLICY_KEY = "policy.published";

export function readPolicy(db: Db): OrganisationPolicy {
  const stored = getSetting<unknown>(db, POLICY_KEY, null);
  if (stored === null) return NO_POLICY;
  const parsed = OrganisationPolicySchema.safeParse(stored);
  return parsed.success ? parsed.data : NO_POLICY;
}

export function writePolicy(db: Db, policy: OrganisationPolicy): void {
  setSetting(db, POLICY_KEY, policy);
}

/**
 * The policy, where it should protect rows this machine only holds a
 * *copy* of (EO-328, ARCHITECTURE.md, "Policy", review).
 *
 * `NO_POLICY` on the record itself, and that is the correction rather
 * than a loophole. The managed-row refusal exists because a desktop's
 * published MCP definitions are copies: editing one there runs something
 * the name does not describe until the next sync puts the definition
 * back, so the alteration is both effective and temporary.
 *
 * None of that is true on the server. The rows in its catalogue *are*
 * the definitions — `applyPublishedMcpServers` never runs there, because
 * `syncPolicy` returns immediately when this process has no record to
 * ask — and `policy.mcpServers` is a snapshot of them taken when the
 * admin last pressed Publish. So refusing an edit there left an admin
 * unable to change a definition at all except by withdrawing it, which
 * archives it on every desktop that has it.
 *
 * An edit on the server reaches devices on the next **publish**, not on
 * the next sync, which is the design's shape: publishing is an explicit act,
 * and the Policy screen snapshots the catalogue as it stands when the
 * button is pressed.
 */
export function policyProtectingCopies(db: Db, isTheRecord: boolean): OrganisationPolicy {
  return isTheRecord ? NO_POLICY : readPolicy(db);
}

/**
 * Forgets the copy this machine was keeping — what signing out of an
 * organisation owes.
 *
 * Cleared rather than overwritten with `NO_POLICY`, which `readPolicy`
 * would answer identically: a row that is gone is a machine that never
 * had one, and the two states should not be distinguishable afterwards.
 *
 * The design's promise that a desktop keeps working on its last published
 * version is about an *outage*. A sign-out is the relationship ending,
 * and a machine that kept an organisation's allowed-backends list after
 * leaving would refuse its own owner's dispatches on the authority of a
 * record it no longer belongs to.
 */
export function forgetPolicy(db: Db): void {
  clearSetting(db, POLICY_KEY);
}

/**
 * What today has cost the person this machine is signed in as, against
 * what they are allowed.
 *
 * Null wherever there is no ceiling — a solo desktop, and a managed one
 * whose organisation published none — because a spend with no budget
 * beside it is a number with no meaning, and the top bar draws nothing
 * rather than half a sentence.
 *
 * **The local calendar day**, which is `startOfDay`'s definition and the
 * installation-wide daily guard's already. Two budgets that turned over
 * at different moments would be two answers to "today" on one screen.
 */
export function personBudgetFor(db: Db, policy: OrganisationPolicy, personId: Uuid | null, now: number = Date.now()): PersonBudget | null {
  const budgetCents = policy.perPersonDailyBudgetCents;
  // Nobody to have a budget: the operator's key administers an
  // organisation without being a member of one, so there is no day of
  // theirs to report and a nought would read as "you have spent
  // nothing" rather than "this question is not about you".
  if (budgetCents === null || personId === null) return null;
  return { spentCents: personCostCentsSince(db, personId, startOfDay(now)), budgetCents };
}

/**
 * The budget this dispatch would breach, or null.
 *
 * Asked of whoever this machine is signed in as rather than of the
 * item's own owner, and that is the honest reading of the original design's "**per
 * person**, the owner a job's items draw on": the spend being counted is
 * the spend this device is about to add to, and this device runs as one
 * person. A desktop signed in to nothing answers against the implicit
 * local person, whose projects have no owner on the record — so the sum
 * is nought, and with no budget published the question is never asked at
 * all.
 */
export function personOverBudget(db: Db, policy: OrganisationPolicy, now: number = Date.now()): PersonBudget | null {
  const budget = personBudgetFor(db, policy, signedInPersonId(db), now);
  if (budget === null) return null;
  return overPersonBudget(budget) ? budget : null;
}

/**
 * Whether the person whose item this is has spent their day, as **this
 * database** counts it (EO-328, ARCHITECTURE.md, "Policy", review).
 *
 * Asked by the record, in `localRecord.offerWork`, which is the one
 * place the question is answered from the right rows by construction: a
 * record holds every device's runs, so its own sum *is* the person-wide
 * total and no round trip is needed to get it. On a desktop the same
 * function would be asking a replica, which is why the desktop's
 * pre-dispatch guard goes over the wire instead
 * (`ItemRecord.personSpendToday`).
 *
 * By the item's owner rather than by whoever this machine signed in as,
 * because the record is answering about somebody else's work: a server
 * has no "you", and Anna's item is Anna's whichever desktop asked for
 * it.
 *
 * Null wherever there is nothing to enforce — no ceiling published, or
 * an item whose project nobody on the record owns, which is every item
 * of a solo installation.
 */
export function overPersonBudgetForItem(db: Db, policy: OrganisationPolicy, itemId: Uuid, now: number = Date.now()): PersonBudget | null {
  if (policy.perPersonDailyBudgetCents === null) return null;
  const budget = personBudgetFor(db, policy, ownerOfItem(db, itemId), now);
  if (budget === null) return null;
  return overPersonBudget(budget) ? budget : null;
}
