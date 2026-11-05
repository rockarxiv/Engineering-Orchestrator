import { describe, expect, it } from "vitest";
import { EMPTY_SPEC_SHAPE } from "../schemas/specShape.js";
import { DEVELOPER_VOCABULARY, developerRegistry } from "./developer.js";
import { emptyRegistry, qualifiedItemType, type ItemTypeEntry, type PackVocabulary, type RegistryFacts } from "./index.js";
import { builtinResultLabel, chromeVocabulary, containerLabel } from "./vocabulary.js";

/**
 * The rule the design states twice and in two directions (EO-309).
 *
 * "The core's chrome says item" and "a developer's board does not change
 * a word" are the same sentence read from two projects, and this is
 * where that is decided. Every case below is one of the three counts
 * `chromeVocabulary` turns on — one pack, several, none — because the
 * bugs this rule can have are all "the wrong count": a hand-made type
 * counted as a pack, a pack with no vocabulary counted as one, an
 * unanswered `registry:get` counted as a mixture.
 */

const SUPPORT: PackVocabulary = { item: "Case", items: "Cases", results: { escalation: "Hand to a supervisor" } };

function type(packSlug: string, slug: string, label: string, container = false): ItemTypeEntry {
  return { packSlug, slug, label, plural: `${label}s`, container, specShape: EMPTY_SPEC_SHAPE, actionOverrides: {} };
}

function registryOf(types: ItemTypeEntry[], packs: [string, PackVocabulary][] = []): RegistryFacts {
  return { ...emptyRegistry(), itemTypes: new Map(types.map((entry) => [qualifiedItemType(entry), entry])), packs: new Map(packs) };
}

describe("what the core's chrome calls an item", () => {
  /**
   * The acceptance criterion a developer cares about, at its root: the
   * installation EO ships has one pack, so the chrome is that pack's
   * word and no row has to say which of three types it is.
   */
  it("is the pack's own word on a project with one pack", () => {
    expect(chromeVocabulary(developerRegistry())).toEqual({ item: "Ticket", items: "Tickets", mixed: false });
  });

  it("is the neutral word once a second pack contributes a type", () => {
    const registry = registryOf(
      [type("developer", "story", "Story"), type("support", "case", "Case")],
      [["developer", DEVELOPER_VOCABULARY], ["support", SUPPORT]],
    );

    expect(chromeVocabulary(registry)).toEqual({ item: "Item", items: "Items", mixed: true });
  });

  /**
   * The loading frame, and the core with no pack installed (invariant
   * 13), are one case: there is no word but the neutral one, and
   * nothing to disambiguate — so `mixed` is false and no row grows a
   * label it would only have to lose again a frame later.
   */
  it("is the neutral word with no packs at all, and asks for no labels", () => {
    expect(chromeVocabulary(emptyRegistry())).toEqual({ item: "Item", items: "Items", mixed: false });
  });

  /**
   * A type somebody made in the configure screen (ARCHITECTURE.md, "An item type is data") is filed
   * under
   * `local` and ships no vocabulary of its own. Counting it would rename
   * every screen in the app for a developer who added one type, which is
   * the opposite of what they asked for.
   */
  it("is unmoved by a type a person made by hand", () => {
    const registry = registryOf(
      [type("developer", "story", "Story"), type("local", "chore", "Chore")],
      [["developer", DEVELOPER_VOCABULARY]],
    );

    expect(chromeVocabulary(registry)).toEqual({ item: "Ticket", items: "Tickets", mixed: false });
  });

  /** A pack may ship types and no vocabulary. Then there is no word to borrow. */
  it("falls back to the neutral word for a pack that named none", () => {
    expect(chromeVocabulary(registryOf([type("support", "case", "Case")]))).toEqual({ item: "Item", items: "Items", mixed: false });
  });
});

describe("what the pack calls the results the engine produces", () => {
  it("answers with the one pack's word", () => {
    const registry = registryOf([type("support", "case", "Case")], [["support", SUPPORT]]);

    expect(builtinResultLabel(registry, "escalation")).toBe("Hand to a supervisor");
  });

  /**
   * Null rather than a guess, so the caller keeps its own spelling —
   * `humanize` in the route editor, and the route row's own label
   * wherever a pipeline has declared one.
   */
  it("answers null for a result the pack says nothing about", () => {
    expect(builtinResultLabel(registryOf([type("support", "case", "Case")], [["support", SUPPORT]]), "needs_user_input")).toBeNull();
    expect(builtinResultLabel(developerRegistry(), "reviewed")).toBeNull();
  });

  /**
   * The developer spellings are today's, on purpose: they are what
   * migration 0028 put on the shipped pipeline's route and what
   * `humanize` would have produced anyway, so wiring the vocabulary in
   * changes no word on a developer's editor.
   */
  it("keeps the developer pack reading exactly as it did", () => {
    expect(builtinResultLabel(developerRegistry(), "needs_user_input")).toBe("Needs user input");
    expect(builtinResultLabel(developerRegistry(), "escalation")).toBe("Escalation");
  });
});

describe("what the project calls the thing that holds other work", () => {
  it("is the container type's own label", () => {
    expect(containerLabel(developerRegistry())).toBe("Feature");
    expect(containerLabel(registryOf([type("support", "campaign", "Campaign", true)]))).toBe("Campaign");
  });

  it("is a neutral word where there is no single container type", () => {
    expect(containerLabel(emptyRegistry())).toBe("Parent");
    expect(containerLabel(registryOf([type("developer", "feature", "Feature", true), type("support", "campaign", "Campaign", true)]))).toBe("Parent");
  });
});
