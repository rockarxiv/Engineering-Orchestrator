import { ORGANISATION_SECRET_LINE, type EnvironmentVariable, type IpcResponse } from "@eo/core";

/**
 * What each of the two lists says about a name the other one fills
 * (EO-486, ARCHITECTURE.md §14.2).
 *
 * Within one scope a name is a secret or an environment variable, never
 * both — so a declared name that is a variable has no secret, and a list
 * that only knew its own entries would draw it as "Not set", a debt the
 * person does not owe. Both layouts' Secrets and Environment variables
 * lists read their lines from here, so the two say the same thing about
 * the same stored entry.
 *
 * The order is how a module's name is resolved: the organisation's
 * secret, then the step's own entry of either kind, then the shared one.
 */

export type ModuleSecretsList = IpcResponse<"moduleSecrets:list">;

export interface StatusLine {
  text: string;
  /** Which tone the layout draws it in; each layout maps these to its own colours. */
  tone: "own" | "inherited" | "missing";
}

/** The line a Secrets row reads when the name's value is a variable, or null when it is not one. */
export function variableLineForSecret(name: string, variables: readonly EnvironmentVariable[], scope: string | null): StatusLine | null {
  if (scope !== null && variables.some((variable) => variable.name === name && variable.scope === "step")) {
    return { text: "Set as an environment variable for this step", tone: "own" };
  }
  if (variables.some((variable) => variable.name === name && variable.scope === "shared")) {
    return { text: "Set as an environment variable", tone: "inherited" };
  }
  return null;
}

/** Whether the secrets list holds a name in one scope as a value a run would be given, or a reference. */
function secretIn(secrets: ModuleSecretsList | undefined, name: string, where: "shared" | "step"): boolean {
  if (secrets === undefined) return false;
  const references = secrets.references ?? [];
  if (references.some((reference) => reference.name === name && reference.scope === where)) return true;
  return (where === "shared" ? (secrets.names ?? []) : (secrets.overrides ?? [])).includes(name);
}

/**
 * Whether one scope holds a stored secret for a name that can no longer
 * be read.
 *
 * `stored` lists every value on disk, readable or not; `names` and
 * `overrides` only the ones a run would be given. A name in the first and
 * not the second is there and unreadable — and, like a dangling
 * reference, it is the answer for that name: `environmentFor` stops at it
 * rather than falling through to the next scope, because a wrong value is
 * worse than none. So no line may claim the fallback it blocks.
 */
export function unreadableSecretIn(secrets: ModuleSecretsList | undefined, name: string, where: "shared" | "step"): boolean {
  if (secrets === undefined) return false;
  const stored = secrets.stored ?? { shared: [], step: [] };
  const readable = where === "shared" ? (secrets.names ?? []) : (secrets.overrides ?? []);
  return stored[where].includes(name) && !readable.includes(name);
}

/** The line for a stored secret that cannot be read, in the scope it is in. */
export function unreadableSecretLine(where: "shared" | "step"): StatusLine {
  return { text: where === "step" ? "Stored as a secret for this step, but it cannot be read" : "Stored as a secret, but it cannot be read", tone: "missing" };
}

/**
 * A declared name's line in a step's or the shared Environment variables
 * list: its own value, the shared one it falls back to, the secret that
 * fills it instead, or nothing.
 *
 * The shared value is spelled out where a step uses it: it is not a
 * secret, and "using the shared value" is only half an answer when the
 * value itself can be shown.
 */
export function variableStatus(
  name: string,
  variables: readonly EnvironmentVariable[],
  secrets: ModuleSecretsList | undefined,
  scope: string | null,
): StatusLine {
  if ((secrets?.organisation ?? []).includes(name)) return { text: ORGANISATION_SECRET_LINE, tone: "inherited" };
  if (scope !== null) {
    if (variables.some((variable) => variable.name === name && variable.scope === "step")) return { text: "Set for this step", tone: "own" };
    // Before anything shared: an unreadable step secret stops the fallback.
    if (unreadableSecretIn(secrets, name, "step")) return unreadableSecretLine("step");
    if (secretIn(secrets, name, "step")) return { text: "Set as a secret for this step", tone: "own" };
  }
  const shared = variables.find((variable) => variable.name === name && variable.scope === "shared");
  if (shared) return { text: scope === null ? "Set" : `Using the shared value · ${shared.value}`, tone: scope === null ? "own" : "inherited" };
  if (unreadableSecretIn(secrets, name, "shared")) return unreadableSecretLine("shared");
  if (secretIn(secrets, name, "shared")) return { text: "Set as a secret", tone: "inherited" };
  return { text: "Not set", tone: "missing" };
}

/**
 * What the Environment variables panel in Settings says about itself, in
 * both layouts.
 *
 * One string rather than one per layout because it is the panel's whole
 * warning — that a variable is not a secret, and who is given it — and
 * two layouts saying different things about the same stored value would
 * make one of them wrong.
 */
export const ENVIRONMENT_VARIABLES_COPY =
  "Not secret: kept unencrypted on this machine, shown here in full, and they appear in transcripts — a token belongs in Secrets. " +
  "Who receives them: a module, for the names it declares in needs.env; an MCP server, for the names it declares and has no secret for; " +
  "and every agent run. These are the shared values — the assistant can set a step's own on a card. " +
  "They stay on this machine and are not exported with a pipeline.";
