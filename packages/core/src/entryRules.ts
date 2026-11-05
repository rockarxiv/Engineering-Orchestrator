import { z } from "zod";
import { fieldLabel } from "./schemas/specShape.js";

/**
 * What a pipeline asks of an item before it may enter (EO-610,
 * ARCHITECTURE.md, "Entry rules").
 *
 * Declared rules rather than a script, and data on the pipeline
 * (invariant 7): a rule can only ask about what EO already holds on the
 * item, so it costs nothing to run at every door and needs no approval.
 * A module step can ask anything, but it asks after the item has entered.
 *
 * `kind` is a string rather than an enum because a pack may contribute
 * one through the registry (`RegistryOf.entryRuleKinds`), which is how the
 * core builds without knowing what a Jira key is (invariant 13).
 */
export const EntryRuleSchema = z.object({
  /** `field`, `description`, `workspace`, or a kind a pack contributed. */
  kind: z.string().min(1),
  /** The spec field a `field` rule asks for, by the name its type declares. */
  field: z.string().min(1).optional(),
  /** The qualified item types it applies to, `developer:story`. Absent is every type. */
  types: z.array(z.string().min(1)).min(1).optional(),
  /** The words a person wants shown instead of the generated ones. */
  message: z.string().min(1).optional(),
});
export type EntryRule = z.infer<typeof EntryRuleSchema>;

export const EntryRulesSchema = z.array(EntryRuleSchema);

/** The kinds every installation answers, whatever packs it has. */
export const CORE_ENTRY_RULE_KINDS: readonly string[] = ["field", "description", "workspace"];

/**
 * A rule kind a pack contributes, as data.
 *
 * Where the value lives rather than a function that reads it, for the
 * reason the registry is a value: the evaluator is pure, the renderer
 * holds the same entry, and a function could not cross either boundary.
 * An item's extensions are already keyed by whoever owns them, so naming
 * a slot and a property is enough to ask about anything a pack keeps.
 */
export interface EntryRuleKind {
  /** The words a refusal generates: "a Jira key". */
  noun: string;
  /** The `Item.extensions` slot the value is in. */
  extension: string;
  /** The property of that slot. */
  property: string;
}

/**
 * Whether a value counts as there.
 *
 * Null, absent, an empty or whitespace-only string and an empty array are
 * missing. `0` and `false` are answers somebody gave.
 */
export function hasEntryValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function withArticle(label: string): string {
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}

/**
 * What a rule is called where it is refused: its own `message`, or words
 * generated from it. One function, so that a refusal and the line on the
 * graph say the same thing.
 */
export function entryRuleWords(rule: EntryRule, kinds: ReadonlyMap<string, EntryRuleKind> | undefined): string {
  const message = rule.message?.trim();
  if (message !== undefined && message !== "") return message;
  if (rule.kind === "field") return withArticle(fieldLabel(rule.field ?? "field"));
  if (rule.kind === "description") return "a description";
  if (rule.kind === "workspace") return "a workspace";
  // A kind nothing here answers still has to be named, or the refusal
  // would stop work with no way to tell which rule did it.
  return kinds?.get(rule.kind)?.noun ?? `"${rule.kind}"`;
}

/** `"Delivery" needs these before work can enter it: a description, a Customer.` */
export function entryRefusalSentence(pipelineName: string, words: readonly string[]): string {
  return `"${pipelineName}" needs these before work can enter it: ${words.join(", ")}.`;
}
