import { LOCAL_PACK } from "../itemTypeAuthoring.js";
import type { PackVocabulary, RegistryFacts } from "./index.js";

/**
 * What the core's own chrome calls an item, and whether the rows below
 * it have to say which kind each one is (ARCHITECTURE.md, "What a pack labels", EO-309).
 *
 * ## The one question this answers
 *
 * the design states two rules that look like they never meet: the core's
 * cross-pipeline chrome — the sidebar place, the archive tab, the
 * search box, the empty states — says **item**, and the developer pack
 * keeps **ticket** so that "phase 6 changes no words on a developer's
 * board" (the original design). They meet here, and the reconciliation is the whole
 * of this module: *the neutral word is what a mixture needs*.
 *
 * A project whose types all come from one pack has no mixture. There is
 * exactly one word for its work, the pack supplied it, and every row on
 * every screen is one of that pack's types — so the chrome says the
 * pack's word and the rows say nothing extra, because "Ticket" beside
 * "Ticket" beside "Ticket" is a column of noise. That is today's
 * developer installation, and it is why nothing on it changes.
 *
 * The moment a second pack contributes a type, the sidebar is listing
 * cases beside reports and there is no word that is both. So the chrome
 * neutralises to "item", and every cross-pipeline row grows its type's
 * label, because that is now the only thing telling a support lead
 * which of the two a row is.
 *
 * ## Why `mixed` is not simply "the word is the neutral one"
 *
 * Both answers come from one count — how many packs contributed this
 * project's types — but they come from it differently, because the
 * count has three cases and not two:
 *
 * - **one pack**: its word, and no labels on rows, since every row
 *   would say the same thing and a column of one repeated word is not
 *   information.
 * - **more than one**: the neutral word, and a label on every
 *   cross-pipeline row, since that label is now the only thing telling
 *   a case from a report.
 * - **none**: the neutral word, because there is no other, and *still*
 *   no labels, because nothing is ambiguous when nothing is there.
 *
 * That third case is not hypothetical and it is not only the core with
 * no pack installed (invariant 13): it is every renderer for the first
 * frame after mount, before `registry:get` has answered. Deriving the
 * labels from "the word is neutral" instead of from "there is a
 * mixture" would make a developer's board flicker a column of "Story"
 * badges into existence and back out again on every cold start.
 *
 * ## Why `local` does not count
 *
 * A person adding a type of their own in the configure screen (ARCHITECTURE.md, "An item type is
 * data")
 * files it under `local`, which is not a pack and ships no vocabulary.
 * Counting it would mean a developer who adds one type finds every
 * screen in the app renamed, which is the opposite of what they asked
 * for. Their new type still appears in every picker and filter under
 * its own label; what it does not do is take the installation's word
 * away.
 */
export interface ChromeVocabulary {
  /** One of them, capitalised for a heading: "Ticket", or "Item". */
  item: string;
  /** Several: "Tickets", or "Items". */
  items: string;
  /**
   * Whether this project's work goes by more than one name — which is
   * the same question as "does a cross-pipeline row have to say what
   * type it is?".
   *
   * False both for the project with one pack and for the project with
   * none; see above for why those two are one answer here and two
   * answers for the word.
   */
  mixed: boolean;
}

/**
 * The core's own word, for a project whose work has more than one name.
 *
 * Capitalised because every place it is read is a heading, a tab or a
 * nav entry; the two sentences that need it in the middle of a line
 * lowercase it themselves rather than carrying a third spelling here.
 */
export const NEUTRAL_VOCABULARY: ChromeVocabulary = { item: "Item", items: "Items", mixed: false };

/**
 * Which pack's word this project goes by, or none.
 *
 * Read off the *types the project has*, not off the packs the
 * installation has installed: `registryForProject` answers with
 * `item_types` rows scoped to one project, and a pack that is installed
 * but contributes nothing this project uses has no claim on its
 * vocabulary.
 */
function packsOf(registry: RegistryFacts): string[] {
  const slugs = new Set<string>();
  for (const type of registry.itemTypes.values()) {
    if (type.packSlug === LOCAL_PACK) continue;
    slugs.add(type.packSlug);
  }
  return [...slugs];
}

/** The one pack's vocabulary, where there is one pack and it shipped one. */
function solePackOf(registry: RegistryFacts): PackVocabulary | null {
  const slugs = packsOf(registry);
  return slugs.length === 1 ? (registry.packs.get(slugs[0]!) ?? null) : null;
}

/** See {@link ChromeVocabulary}. */
export function chromeVocabulary(registry: RegistryFacts): ChromeVocabulary {
  const mixed = packsOf(registry).length > 1;
  const sole = mixed ? null : solePackOf(registry);
  if (sole === null) return { ...NEUTRAL_VOCABULARY, mixed };
  return { item: sole.item, items: sole.items, mixed: false };
}

/**
 * What to call one of the results the engine produces on its own —
 * `needs_user_input`, `escalation` — on a project with one pack's
 * vocabulary.
 *
 * `null` where nothing has a word for it, which leaves the caller its
 * own spelling: the route row's `label` where a pipeline declared one,
 * and `humanize` where nobody has.
 */
export function builtinResultLabel(registry: RegistryFacts, resultKey: string): string | null {
  return solePackOf(registry)?.results[resultKey] ?? null;
}

/**
 * What this project calls the thing that holds other work — "Feature"
 * in the developer pack (EO-309, ARCHITECTURE.md, "An item type is data").
 *
 * Read off the container types rather than off a pack's vocabulary,
 * because a container is a *type* and the word for it is that type's
 * label: a pack whose container is an Epic or a Campaign gets its own
 * word here without EO learning either.
 *
 * "Parent" where the project has no container type or more than one,
 * which are the two cases with no single right word: the filter is
 * still exactly as useful, since what it offers is the containers
 * themselves by name.
 */
export function containerLabel(registry: RegistryFacts): string {
  const containers = [...registry.itemTypes.values()].filter((type) => type.container);
  return containers.length === 1 ? containers[0]!.label : "Parent";
}
