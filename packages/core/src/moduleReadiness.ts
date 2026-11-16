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
