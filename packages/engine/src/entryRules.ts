import { CORE_ENTRY_RULE_KINDS, entryRefusalSentence, entryRuleWords, hasEntryValue } from "@eo/core";
import type { EntryRule, EntryRuleKind, ItemTypeEntry } from "@eo/core";

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

/** The rules these facts fail, in the order the pipeline lists them. */
export function unmetEntryRules(rules: readonly EntryRule[], facts: EntryFacts, kinds: ReadonlyMap<string, EntryRuleKind> | undefined): EntryRule[] {
  return rules.filter((rule) => appliesTo(rule, facts.itemType) && !isMet(rule, facts, kinds));
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
): string[] {
  return rules.flatMap((rule) => {
    const named = `The entry rule asking for ${entryRuleWords(rule, kinds)}`;
    if (!CORE_ENTRY_RULE_KINDS.includes(rule.kind) && !kinds?.has(rule.kind)) {
      return [`The entry rule "${rule.kind}" is a kind nothing installed here can answer.`];
    }
    const unknown = (rule.types ?? []).filter((type) => !itemTypes.has(type));
    const problems = unknown.map((type) => `${named} names the item type "${type}", which this project does not have.`);
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
