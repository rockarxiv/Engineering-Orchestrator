import { z } from "zod";
import { DEFAULT_MODULE_TIMEOUT_MS } from "./limits.js";
import { fieldLabel } from "./schemas/specShape.js";

/**
 * What a pipeline asks of an item before it may enter (EO-610,
 * ARCHITECTURE.md, "Entry rules").
 *
 * Declared rules, and data on the pipeline (invariant 7). Every kind but
 * one asks only about what EO already holds on the item, so it costs
 * nothing to run at every door and needs no approval. The one exception
 * is `module` (EO-736): it names an approved module declared an entry
 * check, which EO runs against the item as it would enter and lets it in
 * only on `pass`. Read-only, time-bounded and failing closed — see
 * ARCHITECTURE.md, "Entry rules".
 *
 * `kind` is a string rather than an enum because a pack may contribute
 * one through the registry (`RegistryOf.entryRuleKinds`), which is how the
 * core builds without knowing what a Jira key is (invariant 13).
 */
export const EntryRuleSchema = z.object({
  /** `field`, `description`, `workspace`, `module`, or a kind a pack contributed. */
  kind: z.string().min(1),
  /** The spec field a `field` rule asks for, by the name its type declares. */
  field: z.string().min(1).optional(),
  /** The module a `module` rule runs, by id (EO-736). An export carries its slug instead. */
  module: z.string().min(1).optional(),
  /**
   * How long a `module` rule's check may take, in milliseconds (EO-736).
   * Absent is `DEFAULT_ENTRY_CHECK_TIMEOUT_MS`; never above the module limit.
   */
  timeoutMs: z.number().int().positive().optional(),
  /** The qualified item types it applies to, `developer:story`. Absent is every type. */
  types: z.array(z.string().min(1)).min(1).optional(),
  /** The words a person wants shown instead of the generated ones. */
  message: z.string().min(1).optional(),
});
export type EntryRule = z.infer<typeof EntryRuleSchema>;

export const EntryRulesSchema = z.array(EntryRuleSchema);

/** The kinds every installation answers, whatever packs it has. */
export const CORE_ENTRY_RULE_KINDS: readonly string[] = ["field", "description", "workspace", "module"];

/** The one kind that runs code rather than reading data (EO-736). */
export const MODULE_ENTRY_RULE_KIND = "module";

/**
 * How long an entry check may take when its rule says nothing (EO-736).
 * Short, because somebody is waiting at the door: a person at the item
 * form, an agent at `work_submit_item`, a run handing work on.
 */
export const DEFAULT_ENTRY_CHECK_TIMEOUT_MS = 30 * 1000;

/** What an entry check answers with: `{ ok: true, result: "pass" }` or `{ ok: true, result: "refuse", reason }`. */
export const ENTRY_CHECK_PASS = "pass";
export const ENTRY_CHECK_REFUSE = "refuse";

/** The door an item is entering by, as an entry check's `ctx.entry.door` names it (EO-736). */
export type EntryDoor = "creation" | "move" | "route" | "job";

/** The most an entry check may be given: what any module may take. */
export const MAX_ENTRY_CHECK_TIMEOUT_MS = DEFAULT_MODULE_TIMEOUT_MS;

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
export function entryRuleWords(
  rule: EntryRule,
  kinds: ReadonlyMap<string, EntryRuleKind> | undefined,
  /** Module names by id, for a `module` rule's words. Absent, the id is used. */
  moduleNames?: ReadonlyMap<string, string>,
): string {
  const message = rule.message?.trim();
  if (message !== undefined && message !== "") return message;
  if (rule.kind === "field") return withArticle(fieldLabel(rule.field ?? "field"));
  if (rule.kind === "description") return "a description";
  if (rule.kind === "workspace") return "a workspace";
  if (rule.kind === MODULE_ENTRY_RULE_KIND) return `a pass from "${moduleNames?.get(rule.module ?? "") ?? rule.module ?? "a module"}"`;
  // A kind nothing here answers still has to be named, or the refusal
  // would stop work with no way to tell which rule did it.
  return kinds?.get(rule.kind)?.noun ?? `"${rule.kind}"`;
}

/** `"Delivery" needs these before work can enter it: a description, a Customer.` */
export function entryRefusalSentence(pipelineName: string, words: readonly string[]): string {
  return `"${pipelineName}" needs these before work can enter it: ${words.join(", ")}.`;
}

/**
 * Why a manifest declaring itself an entry check may not be approved, one
 * sentence per reason, or none (EO-736).
 *
 * An entry check runs before the item exists, at a door somebody is
 * standing at, so it may only look: no item created, no comment, no
 * file, nothing sent outside EO. Reading — the network, binaries,
 * environment variables and secrets — is how it asks a forge anything,
 * and stays allowed.
 */
export function entryCheckManifestProblems(manifest: {
  entryCheck?: boolean | undefined;
  sideEffects?: boolean | undefined;
  needs: { create: boolean; comment: boolean; attach: boolean };
}): string[] {
  if (manifest.entryCheck !== true) return [];
  const declared = [
    manifest.needs.create ? "needs.create" : null,
    manifest.needs.comment ? "needs.comment" : null,
    manifest.needs.attach ? "needs.attach" : null,
    manifest.sideEffects === true ? "sideEffects" : null,
  ].filter((each): each is string => each !== null);
  return declared.map((name) => `An entry check only reads, so it may not declare ${name}.`);
}
