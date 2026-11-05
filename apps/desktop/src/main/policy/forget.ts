import type { Db } from "../db/client.js";
import { forgetOrganisationSecrets, type OrganisationSecretsOptions } from "./organisationSecrets.js";
import { forgetPolicy } from "./policy.js";

/**
 * Everything an organisation gave this machine, forgotten (EO-328,
 * ARCHITECTURE.md, "Secrets", review).
 *
 * Two things: the published policy this desktop cached, and the values
 * behind the secret names it published. Both are copies held on the
 * strength of a credential, and the moment that credential stops being
 * honoured they are copies of somebody else's configuration that nobody
 * has authorised this machine to hold.
 *
 * ## Why it is a function rather than two calls at each site
 *
 * Because there are three sites and one of them was missed. An explicit
 * **sign-out** cleared both. A **revocation** — the admin pressing
 * Revoke, learned by whichever request next met a 401 — only announced
 * itself to the open windows and left the caches where they were. So a
 * revoked desktop went on injecting the organisation's secrets into
 * every module it ran for the projects it still schedules, and went on
 * enforcing an allowed-backends list from a record it no longer belongs
 * to. The two are the same event as far as this is concerned: this
 * machine is no longer part of that organisation.
 *
 * It does **not** touch the session itself. `forgetSession` and
 * `markRevoked` are the two writers of that, and they differ from each
 * other in ways this has no opinion about — a revocation keeps the
 * address and the email so the sign-in screen comes back pre-filled
 * with the sentence above it, and a sign-out does not.
 *
 * Idempotent, because it has to be: several requests can meet the same
 * 401 together. `markRevoked` answers whether the transition was this
 * one, so in practice this runs once — but a second pass removes two
 * files that are already gone, which is what `rm -f` is for.
 */
export function forgetOrganisationState(db: Db, secrets: OrganisationSecretsOptions): void {
  // The secrets first. They are the half with a security answer attached
  // — a credential this machine should not still be spending — and the
  // policy is the half with a behaviour answer. If one of the two were
  // ever going to fail, this is the order to fail in.
  forgetOrganisationSecrets(secrets);
  forgetPolicy(db);
}
