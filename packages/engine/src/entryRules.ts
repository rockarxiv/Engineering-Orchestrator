import {
  CORE_ENTRY_RULE_KINDS,
  DEFAULT_ENTRY_CHECK_TIMEOUT_MS,
  MAX_ENTRY_CHECK_TIMEOUT_MS,
  MODULE_ENTRY_RULE_KIND,
  describeDuration,
  entryCheckManifestProblems,
  entryRefusalSentence,
  entryRuleWords,
  hasEntryValue,
} from "@eo/core";
import type { CustomModule, EntryRule, EntryRuleKind, ItemTypeEntry } from "@eo/core";

/**
 * Judging a pipeline's entry rules (EO-610, ARCHITECTURE.md, "Entry
 * rules"). Data in, data out (invariant 2): the caller reads the item,
 * or what a job would make of its template, and hands the facts here.
 */
export interface EntryFacts {
  /** The item's type, qualified: `developer:story`. */
  itemType: string;
  body: string | null;
  spec: Readonly<Record<string, unknown>> | null;
  hasWorkspace: boolean;
  /** The fields the item's type declares. A rule on any other field is missing. */
  declaredFields: readonly string[];
  /** Pack state, keyed by the extension that owns it. */
  extensions: Readonly<Record<string, unknown>>;
}

function appliesTo(rule: EntryRule, itemType: string): boolean {
  return rule.types === undefined || rule.types.includes(itemType);
}

function extensionValue(extensions: EntryFacts["extensions"], kind: EntryRuleKind): unknown {
  const slot = extensions[kind.extension];
  return slot !== null && typeof slot === "object" ? (slot as Record<string, unknown>)[kind.property] : undefined;
}

function isMet(rule: EntryRule, facts: EntryFacts, kinds: ReadonlyMap<string, EntryRuleKind> | undefined): boolean {
  if (rule.kind === "field") {
    return rule.field !== undefined && facts.declaredFields.includes(rule.field) && hasEntryValue(facts.spec?.[rule.field]);
  }
  if (rule.kind === "description") return hasEntryValue(facts.body);
  if (rule.kind === "workspace") return facts.hasWorkspace;
  const kind = kinds?.get(rule.kind);
  // A kind whose pack is gone cannot be answered. The pipeline said
  // nothing comes in without this, so it stays shut and names the rule,
  // rather than quietly admitting what it was written to keep out.
  return kind !== undefined && hasEntryValue(extensionValue(facts.extensions, kind));
}

/**
 * The data rules these facts fail, in the order the pipeline lists them.
 *
 * A `module` rule is not judged here: it runs code, which this package
 * never does (invariant 2). `moduleEntryChecks` says which to run, and the
 * caller runs them only once every rule here is met (EO-736).
 */
export function unmetEntryRules(rules: readonly EntryRule[], facts: EntryFacts, kinds: ReadonlyMap<string, EntryRuleKind> | undefined): EntryRule[] {
  return rules.filter((rule) => rule.kind !== MODULE_ENTRY_RULE_KIND && appliesTo(rule, facts.itemType) && !isMet(rule, facts, kinds));
}

/** One module an arrival has to pass, and the rules that name it (EO-736). */
export interface ModuleEntryCheck {
  /** The module's id. */
  module: string;
  /** Every applicable rule naming it, in the order the pipeline lists them. */
  rules: EntryRule[];
  /** The one run's limit: the tightest any of those rules sets, or the default. */
  timeoutMs: number;
}

/**
 * The modules an item of this type must pass to enter, in the order their
 * first rule is listed (EO-736).
 *
 * One entry per module, whatever the number of rules naming it, so rules
 * naming the same module share one run per door per item. A rule naming
 * no module is still listed, under the empty id, so it refuses rather
 * than being skipped: the pipeline said nothing comes in without it.
 */
export function moduleEntryChecks(rules: readonly EntryRule[], itemType: string): ModuleEntryCheck[] {
  const checks = new Map<string, ModuleEntryCheck>();
  for (const rule of rules) {
    if (rule.kind !== MODULE_ENTRY_RULE_KIND || !appliesTo(rule, itemType)) continue;
    const id = rule.module ?? "";
    const limit = Math.min(rule.timeoutMs ?? DEFAULT_ENTRY_CHECK_TIMEOUT_MS, MAX_ENTRY_CHECK_TIMEOUT_MS);
    const found = checks.get(id);
    if (found === undefined) checks.set(id, { module: id, rules: [rule], timeoutMs: limit });
    else {
      found.rules.push(rule);
      found.timeoutMs = Math.min(found.timeoutMs, limit);
    }
  }
  return [...checks.values()];
}

/** A module as a `module` rule is judged against it: the catalog's own fields. */
export type EntryCheckModule = Pick<CustomModule, "id" | "name" | "approvedAt" | "archivedAt" | "manifest">;

/**
 * Why this module cannot be an entry check now, as a clause about it, or
 * null (EO-736): missing, deleted, unapproved, not declared one, or
 * declaring more than reading. Asked when a pipeline is published and
 * again at every door, since an approval can be withdrawn in between.
 */
export function entryCheckModuleProblem(module: EntryCheckModule | undefined): string | null {
  if (module === undefined || module.archivedAt !== null) return "is not a module this installation has";
  if (module.approvedAt === null) return "has not been approved";
  if (module.manifest.entryCheck !== true) return "is not declared an entry check (entryCheck: true in its manifest)";
  const reaching = entryCheckManifestProblems(module.manifest);
  if (reaching.length > 0) return `declares more than an entry check may: ${reaching.join(" ")}`;
  return null;
}

/** The sentence naming everything missing at once, or null when nothing is. */
export function entryRefusal(pipelineName: string, rules: readonly EntryRule[], facts: EntryFacts, kinds: ReadonlyMap<string, EntryRuleKind> | undefined): string | null {
  const unmet = unmetEntryRules(rules, facts, kinds);
  return unmet.length === 0 ? null : entryRefusalSentence(pipelineName, unmet.map((rule) => entryRuleWords(rule, kinds)));
}

/** The sentences a set of rules is refused with, for `validatePipeline` and an import. */
export function entryRuleProblems(
  rules: readonly EntryRule[],
  itemTypes: ReadonlyMap<string, Pick<ItemTypeEntry, "specShape">>,
  kinds: ReadonlyMap<string, EntryRuleKind> | undefined,
  /**
   * The module catalog a `module` rule is judged against (EO-736). Absent
   * — a caller with no catalog to hand — judges only the rule's own shape;
   * `validatePipeline` passes it, so nothing is published unjudged.
   */
  modules?: readonly EntryCheckModule[],
): string[] {
  const moduleNames = new Map((modules ?? []).map((module) => [module.id, module.name]));
  return rules.flatMap((rule) => {
    const named = `The entry rule asking for ${entryRuleWords(rule, kinds, moduleNames)}`;
    if (!CORE_ENTRY_RULE_KINDS.includes(rule.kind) && !kinds?.has(rule.kind)) {
      return [`The entry rule "${rule.kind}" is a kind nothing installed here can answer.`];
    }
    const unknown = (rule.types ?? []).filter((type) => !itemTypes.has(type));
    const problems = unknown.map((type) => `${named} names the item type "${type}", which this project does not have.`);
    if (rule.kind === MODULE_ENTRY_RULE_KIND) {
      if (rule.timeoutMs !== undefined && rule.timeoutMs > MAX_ENTRY_CHECK_TIMEOUT_MS) {
        problems.push(`${named} may take ${describeDuration(rule.timeoutMs)}, more than the ${describeDuration(MAX_ENTRY_CHECK_TIMEOUT_MS)} any module may.`);
      }
      if (rule.module === undefined) problems.push("An entry rule that runs a module does not say which module.");
      else if (modules !== undefined) {
        const { module: id } = rule;
        const module = modules.find((each) => each.id === id);
        const problem = entryCheckModuleProblem(module);
        if (problem !== null) problems.push(`The entry rule runs "${module?.name ?? id}", which ${problem}.`);
      }
    }
    if (rule.kind === "field") {
      if (rule.field === undefined) return [...problems, `${named} does not say which field.`];
      const { field } = rule;
      const applicable = rule.types === undefined ? [...itemTypes.values()] : rule.types.flatMap((type) => itemTypes.get(type) ?? []);
      if (!applicable.some((type) => field in type.specShape.properties)) {
        problems.push(`${named} needs the field "${field}", which no item type it applies to on this project declares.`);
      }
    }
    return problems;
  });
}
