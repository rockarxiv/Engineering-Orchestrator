import { z } from "zod";

/**
 * Whether a module's declared prerequisites are there on this machine, for
 * one run of it (EO-816): every `needs.bin` and every `needs.env`, each by
 * name with what EO found — and never a value.
 *
 * Separate from approval on purpose. Approval is about the code and holds
 * on every device; readiness is about this device and this scope, and is
 * asked again before every run rather than remembered, so a CLI installed
 * or a variable set since makes the next run go and nothing has to be
 * approved again.
 *
 * The statuses are the answers `environmentFor` already gives a run, so a
 * check and the run after it cannot disagree about a name:
 *
 * - `set` — the run would be given a value.
 * - `unset` — nothing anywhere the run reads says anything about the name.
 * - `unreadable` — a value is stored and cannot be decrypted or read.
 * - `dangling` — the name is read from one of EO's environment variables,
 *   `variable`, which is missing or empty where EO was started.
 * - `withheld` — a step a trial redirects sets the name and its trial-only
 *   values do not, so neither the step's nor the shared value is given.
 */
export const ModuleBinaryReadinessSchema = z.object({
  name: z.string(),
  status: z.enum(["found", "missing"]),
});
export type ModuleBinaryReadiness = z.infer<typeof ModuleBinaryReadinessSchema>;

export const ModuleEnvironmentReadinessSchema = z.discriminatedUnion("status", [
  z.object({ name: z.string(), status: z.literal("set") }),
  z.object({ name: z.string(), status: z.literal("unset") }),
  z.object({ name: z.string(), status: z.literal("unreadable") }),
  z.object({ name: z.string(), status: z.literal("dangling"), variable: z.string() }),
  z.object({ name: z.string(), status: z.literal("withheld") }),
]);
export type ModuleEnvironmentReadiness = z.infer<typeof ModuleEnvironmentReadinessSchema>;

export const ModuleReadinessSchema = z.object({
  ready: z.boolean(),
  bin: z.array(ModuleBinaryReadinessSchema),
  env: z.array(ModuleEnvironmentReadinessSchema),
});
export type ModuleReadiness = z.infer<typeof ModuleReadinessSchema>;

function names(list: readonly string[]): string {
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * One clause per kind of thing missing, each saying what fixes it, or
 * none where the module is ready. Every missing prerequisite is in them,
 * so a person fixes all of it in one visit rather than one per retry.
 */
export function moduleReadinessProblems(readiness: ModuleReadiness): string[] {
  const problems: string[] = [];
  const bins = readiness.bin.filter((bin) => bin.status === "missing").map((bin) => bin.name);
  if (bins.length > 0) {
    problems.push(
      `${names(bins)} ${bins.length === 1 ? "is" : "are"} not installed here, or not on any PATH EO searches — install ${bins.length === 1 ? "it" : "them"}; EO never installs software itself`,
    );
  }
  const of = (status: ModuleEnvironmentReadiness["status"]) => readiness.env.filter((entry) => entry.status === status);
  const unset = of("unset").map((entry) => entry.name);
  if (unset.length > 0) {
    problems.push(`${names(unset)} ${unset.length === 1 ? "is" : "are"} not set — add ${unset.length === 1 ? "it" : "them"} under Settings → Modules, or set ${unset.length === 1 ? "a value" : "values"} on this step`);
  }
  const unreadable = of("unreadable").map((entry) => entry.name);
  if (unreadable.length > 0) {
    problems.push(
      `EO cannot read ${names(unreadable)} — ${unreadable.length === 1 ? "it was" : "they were"} stored by another machine or before this one's keychain was reset; set ${unreadable.length === 1 ? "it" : "them"} again`,
    );
  }
  const dangling = readiness.env.flatMap((entry) => (entry.status === "dangling" ? [entry] : []));
  if (dangling.length > 0) {
    const variables = [...new Set(dangling.map((entry) => entry.variable))];
    problems.push(
      `EO is set to read ${dangling.map((entry) => `${entry.name} from its environment variable ${entry.variable}`).join(", and ")}, and ${names(variables)} ${variables.length === 1 ? "is" : "are"} missing or empty there — ` +
        `EO reads its environment when it starts, so set ${variables.length === 1 ? "it" : "them"} where EO is launched from and restart EO, or store ${dangling.length === 1 ? "a value" : "values"} instead under Settings → Modules`,
    );
  }
  const withheld = of("withheld").map((entry) => entry.name);
  if (withheld.length > 0) {
    problems.push(
      `this step is redirected on this trial, and ${names(withheld)} ${withheld.length === 1 ? "is" : "are"} set on the step but not for its trial — a redirected step is never given the step's own values or the shared ones they replace, so set ${withheld.length === 1 ? "a trial-only value" : "trial-only values"} or run the step for real`,
    );
  }
  return problems;
}

/** The refusal for a run of `moduleName` that is not ready, naming everything missing at once, or null where it is ready. */
export function moduleReadinessRefusal(moduleName: string, readiness: ModuleReadiness): string | null {
  const problems = moduleReadinessProblems(readiness);
  if (problems.length === 0) return null;
  return `"${moduleName}" was not run, because it is not ready on this machine: ${problems.join("; ")}.`;
}

/**
 * A step a module could be checked in the scope of (EO-817): a published
 * step that runs it, named as a person finds it — the pipeline, then the
 * step.
 */
export const ModuleReadinessStepSchema = z.object({
  stepId: z.string(),
  name: z.string(),
  pipelineName: z.string(),
});
export type ModuleReadinessStep = z.infer<typeof ModuleReadinessStepSchema>;

/**
 * What a card is told about whether a module could run on this device
 * (EO-817): the readiness the doors check before they launch, and the
 * facts a person needs to read it — which device answered, in which
 * scope, what an unapplied change adds, and where EO looks for CLIs.
 *
 * Names and statuses only, as `ModuleReadiness` is: never a value.
 *
 * - `device` — what this machine calls itself (its hostname), so the
 *   answer says whose disk and keychain it is about.
 * - `scope` — the shared values every step falls back to, or one
 *   published step's own over them.
 * - `unknownBins` — a declared CLI given as a relative path, which `spawn`
 *   resolves against the run's working directory, and there is no run to
 *   take one from. Not in `readiness.bin`, and neither found nor missing.
 * - `introduced` — what the change being proposed declares that the
 *   saved module does not. Empty when no change is being looked at.
 * - `searched` — the directories a bare CLI name is looked for in, in
 *   order, as `ctx.exec` would look.
 * - `steps` — every published step that runs the module, which are the
 *   other scopes it can be checked in.
 */
export const ModuleReadinessCheckSchema = z.object({
  device: z.string(),
  platform: z.string(),
  scope: z.discriminatedUnion("kind", [z.object({ kind: z.literal("shared") }), z.object({ kind: z.literal("step"), step: ModuleReadinessStepSchema })]),
  readiness: ModuleReadinessSchema,
  unknownBins: z.array(z.string()),
  introduced: z.object({ bin: z.array(z.string()), env: z.array(z.string()) }),
  searched: z.array(z.string()),
  steps: z.array(ModuleReadinessStepSchema),
});
export type ModuleReadinessCheck = z.infer<typeof ModuleReadinessCheckSchema>;

/** The declared names `needs.env` lists that a run here would not be given, whatever the reason. */
export function unsetModuleEnvironment(readiness: ModuleReadiness): string[] {
  return readiness.env.filter((entry) => entry.status !== "set").map((entry) => entry.name);
}
