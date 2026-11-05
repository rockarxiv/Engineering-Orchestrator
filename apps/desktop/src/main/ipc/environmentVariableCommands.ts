import { MODULE_ENV_NAME_PATTERN, reservedEnvironmentVariableProblem, SECRETS_LIST, type IpcPayload, type IpcResponse } from "@eo/core";
import type { Db } from "../db/client.js";
import { clearVariable, listVariables, readEntry, storeVariable, type ModuleSecretsOptions } from "../modules/secrets.js";
import { knownStep } from "./moduleSecretCommands.js";

/**
 * Environment variables, shared or per step (EO-485, ARCHITECTURE.md §14.2).
 *
 * The other half of the module secrets' channels, and the other way
 * round from them: a variable is not secret, so the list hands back
 * every value and nothing is encrypted. Kept in the same scope
 * directories under userData as the secrets' references, which is what
 * lets a save work with no keychain and a step's removal take its
 * variables with it.
 */

export function listEnvironmentVariables(
  db: Db,
  secrets: ModuleSecretsOptions,
  input: IpcPayload<"environmentVariables:list">,
): IpcResponse<"environmentVariables:list"> {
  const step = knownStep(db, input.stepId);
  return {
    variables: [
      ...listVariables(secrets).map((variable) => ({ ...variable, scope: "shared" as const })),
      ...(step === null ? [] : listVariables(secrets, step).map((variable) => ({ ...variable, scope: "step" as const }))),
    ],
  };
}

/**
 * Sets a variable in one scope, refusing a name that cannot be one.
 *
 * Every refusal is a sentence a screen can put under the field, and every
 * one leaves what was there exactly as it was.
 */
export function setEnvironmentVariable(
  db: Db,
  secrets: ModuleSecretsOptions,
  input: IpcPayload<"environmentVariables:set">,
): IpcResponse<"environmentVariables:set"> {
  if (input.stepId !== null && input.stepId !== undefined && knownStep(db, input.stepId) === null) {
    return { saved: false, problem: "Publish the pipeline first — a variable can only be set on a step that has been saved." };
  }
  const reserved = reservedEnvironmentVariableProblem(input.name);
  if (reserved !== null) return { saved: false, problem: reserved };
  // Empty is how a launcher says "unset" as often as not, and a module
  // checking `if (!ctx.env.REGION)` would read it that way — so a value
  // that would arrive as nothing is refused rather than stored.
  if (input.value === "") {
    return { saved: false, problem: `Give ${input.name} a value. An empty one would reach a run as if it were not set — remove the variable instead.` };
  }
  // No process can be handed one: the OS ends a variable at the first NUL.
  if (input.value.includes("\0")) {
    return { saved: false, problem: `${input.name}'s value contains a NUL character, which no environment variable can hold.` };
  }

  const step = knownStep(db, input.stepId);
  // One name, one list: a secret or a reference already here is the
  // person's, and is not something a variable may quietly replace — a
  // stored secret cannot be read back to put it anywhere first.
  if (readEntry(secrets, input.name, step).state !== "absent") {
    return {
      saved: false,
      problem:
        `${input.name} is already in the ${SECRETS_LIST} list${step === null ? "" : " for this step"}. ` +
        `A name is a secret or an environment variable, never both — remove it from ${SECRETS_LIST} first to make it a variable.`,
    };
  }

  storeVariable(secrets, input.name, input.value, step);
  return { saved: true, problem: null };
}

export function clearEnvironmentVariable(
  db: Db,
  secrets: ModuleSecretsOptions,
  input: IpcPayload<"environmentVariables:clear">,
): IpcResponse<"environmentVariables:clear"> {
  // A step that is already gone took its variables with it.
  const step = knownStep(db, input.stepId);
  if (step === null && input.stepId !== null && input.stepId !== undefined) return { cleared: true };
  // Held to the name shape here, because the channel's request is not:
  // `clear` takes any string, as `moduleSecrets:clear` does, and a name
  // that is not one names no file.
  if (!MODULE_ENV_NAME_PATTERN.test(input.name)) return { cleared: false };

  clearVariable(secrets, input.name, step);
  return { cleared: true };
}
