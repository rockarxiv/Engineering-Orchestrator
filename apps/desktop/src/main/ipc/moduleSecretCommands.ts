import { ENVIRONMENT_VARIABLES_LIST, type IpcPayload, type IpcResponse } from "@eo/core";
import type { Db } from "../db/client.js";
import { getStep } from "../db/repos/index.js";
import {
  clearSecret,
  hasVariable,
  listReferences,
  listSecretNames,
  listStoredNames,
  readEntry,
  storeReference,
  storeSecret,
  type ModuleSecretsOptions,
} from "../modules/secrets.js";
import { listOrganisationSecretNames, type OrganisationSecretsOptions } from "../policy/organisationSecrets.js";

/**
 * The secrets a module can be given, shared or per step (KAN-105).
 *
 * Names in both directions on the record half: the list and the writes
 * tell a screen which secrets exist, never what they are. The one way a
 * value comes back is `revealModuleSecret` below, on the machine half,
 * for the person who pressed Reveal at this desktop (EO-489,
 * ARCHITECTURE.md §14.2).
 *
 * A step id scopes the value to that step. One pipeline can deploy to
 * staging and then to production — the same module, two tokens — so the
 * override belongs on the step rather than on the pipeline, which could
 * only have held one of the two.
 */

/**
 * Whether an override may be attached to this step.
 *
 * It has to exist. A value filed against an id no row carries is a value
 * nothing will ever read — the publish it is waiting on may never happen,
 * and nothing would clean it up if it did not. Better to say so than to
 * accept it and strand it.
 */
export function knownStep(db: Db, stepId: string | null | undefined): string | null {
  if (stepId === null || stepId === undefined) return null;
  return getStep(db, stepId) ? stepId : null;
}

/**
 * `organisation` is read from this machine's own copy of the
 * organisation's store rather than from the policy's `secretNames`
 * (EO-328, ARCHITECTURE.md, "Secrets").
 *
 * The two agree on a synced device and disagree on one that has not
 * synced yet, and what a screen is saying is "a run here would be given
 * this" — which is a fact about this machine's disk, not about what the
 * server has published. It is the same rule `listSecretNames` states for
 * the list beside it: "set" means a dispatch would get a value.
 *
 * Names only, and this is the list the row draws
 * `ORGANISATION_SECRET_LINE` from — the whole claim of which is that the
 * value is on no channel.
 */
export function listModuleSecrets(
  db: Db,
  secrets: ModuleSecretsOptions,
  input: IpcPayload<"moduleSecrets:list">,
  organisation?: OrganisationSecretsOptions,
): IpcResponse<"moduleSecrets:list"> {
  const step = knownStep(db, input.stepId);
  return {
    names: listSecretNames(secrets),
    overrides: step === null ? [] : listSecretNames(secrets, step),
    // Last and optional, so a caller with no organisation in view — a
    // test, and every call site written before this story — reads as
    // what it is: an installation nobody has published to.
    organisation: organisation === undefined ? [] : listOrganisationSecretNames(organisation),
    // Every reference, resolving or not (EO-416) — the two lists above
    // already leave out the ones that do not, because "set" means a
    // dispatch would get a value. The variable's name and a boolean.
    references: [
      ...listReferences(secrets).map((reference) => ({ ...reference, scope: "shared" as const })),
      ...(step === null ? [] : listReferences(secrets, step).map((reference) => ({ ...reference, scope: "step" as const }))),
    ],
    // What a reference saved in each scope would remove (EO-417) — an
    // unreadable value included, which the two lists at the top leave out.
    stored: { shared: listStoredNames(secrets), step: step === null ? [] : listStoredNames(secrets, step) },
  };
}

/**
 * Stores a value, or points the name at one of EO's variables (EO-416).
 *
 * In one scope a name holds one or the other, so each write removes the
 * other kind and says so. Replacing a stored value with a reference is
 * the direction that loses something — the value cannot be read back by
 * anybody, so it cannot be put back either — and `replaced` is how the
 * caller finds out it happened rather than assuming it did not.
 */
export function setModuleSecret(db: Db, secrets: ModuleSecretsOptions, input: IpcPayload<"moduleSecrets:set">): IpcResponse<"moduleSecrets:set"> {
  if (input.stepId !== null && input.stepId !== undefined && knownStep(db, input.stepId) === null) {
    return { saved: false, problem: "Publish the pipeline first — a value can only be set on a step that has been saved.", replaced: null };
  }
  if ((input.value === undefined) === (input.reference === undefined)) {
    return {
      saved: false,
      problem: "Give either a value to store or a reference to one of EO's environment variables — one of the two, not both.",
      replaced: null,
    };
  }

  const step = knownStep(db, input.stepId);
  // One name, one list (EO-485): within a scope a name is a secret or an
  // environment variable, never both. Refused rather than replaced — the
  // variable is the person's own value, and a secret saved over it would
  // leave them with one they can no longer read.
  if (hasVariable(secrets, input.name, step)) {
    return { saved: false, problem: alreadyAVariable(input.name, step), replaced: null };
  }
  // Looked at before the write, since the write is what removes it.
  const before = readEntry(secrets, input.name, step);

  if (input.reference !== undefined) {
    storeReference(secrets, input.name, input.reference.variable ?? input.name, step);
    // An unreadable value is a stored value too: the file was there and
    // is not any more.
    return { saved: true, problem: null, replaced: before.state === "value" || before.state === "unreadable" ? "value" : null };
  }

  // Narrowed by the check above, which the compiler cannot follow across
  // the two fields.
  const result = storeSecret(secrets, input.name, input.value ?? "", step);
  if (!result.ok) return { saved: false, problem: result.reason, replaced: null };
  return { saved: true, problem: null, replaced: before.state === "reference" ? "reference" : null };
}

/** The sentence a secret is refused with when its name is already an environment variable in that scope (EO-485). */
function alreadyAVariable(name: string, step: string | null): string {
  return (
    `${name} is already in the ${ENVIRONMENT_VARIABLES_LIST} list${step === null ? "" : " for this step"}. ` +
    `A name is a secret or an environment variable, never both — remove it from ${ENVIRONMENT_VARIABLES_LIST} first to make it a secret.`
  );
}

export function clearModuleSecret(db: Db, secrets: ModuleSecretsOptions, input: IpcPayload<"moduleSecrets:clear">): IpcResponse<"moduleSecrets:clear"> {
  // A step that is already gone took its overrides with it, so there is
  // nothing left to clear and nothing to complain about.
  const step = knownStep(db, input.stepId);
  if (step === null && input.stepId !== null && input.stepId !== undefined) return { cleared: true };

  clearSecret(secrets, input.name, step);
  return { cleared: true };
}

/**
 * The stored value of one personal module secret in one scope, for the
 * person who pressed Reveal at this desktop (EO-489, ARCHITECTURE.md
 * §14.2).
 *
 * A machine-half channel, so a server refuses it at the door and no
 * eo_admin tool is built on it. What it reads is the scope asked about
 * and nothing wider: the shared value, or a step's own override — never
 * the shared value a step falls back to, and never the organisation's
 * store, so a name the organisation also set is answered with the
 * person's own value.
 *
 * A reference is not revealed. Its variable's name is already on the
 * row, and what the variable holds is EO's environment's rather than
 * anything stored here. A step that no longer exists took its overrides
 * with it and answers `absent`.
 */
export function revealModuleSecret(db: Db, secrets: ModuleSecretsOptions, input: IpcPayload<"moduleSecrets:reveal">): IpcResponse<"moduleSecrets:reveal"> {
  const step = knownStep(db, input.stepId);
  if (step === null && input.stepId !== null && input.stepId !== undefined) return { state: "absent" };

  const entry = readEntry(secrets, input.name, step);
  if (entry.state === "value") return { state: "value", value: entry.value };
  return { state: entry.state };
}
