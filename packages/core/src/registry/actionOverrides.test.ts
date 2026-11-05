import { describe, expect, it } from "vitest";
import {
  actionDefaultsFor,
  actionOverrideFor,
  actionOverridesFor,
  actionSchemaName,
  buildRegistry,
  declaredActionOverrides,
  emptyRegistry,
  qualifiedItemType,
  UNKNOWN_ITEM_TYPE,
  type ActionSubject,
  type ItemTypeEntry,
  type Registry,
} from "./index.js";
import { developerRegistry } from "./developer.js";
import { EMPTY_SPEC_SHAPE } from "../schemas/specShape.js";

/**
 * One per-(type, action) fact, looked up (KAN-163, ARCHITECTURE.md, "An item type is data").
 *
 * `refine` on a container decomposes it and on a leaf clarifies what is
 * already written — one sentence that five sites spelled out for
 * themselves. It is data on the type row now, and this is the lookup
 * every one of those five makes: the type's own override first, then the
 * default the role shipping the action declared for that kind of type.
 *
 * The desktop's `packs/developer/actionOverrides.test.ts` is the other
 * half, walking a run of each kind end to end. This one is about the
 * answer rather than about what is done with it.
 */
const registry = developerRegistry();

const DECOMPOSES = { schema: "refine", resultKey: "decomposed", poster: "refine_proposal" };
const CLARIFIES = { schema: "clarify", resultKey: "clarified", poster: "clarification_note" };

/** A type from a pack nobody wrote, which is the case that matters: it overrides nothing. */
const leaf: ActionSubject = { container: false, actionOverrides: {} };
const container: ActionSubject = { container: true, actionOverrides: {} };

describe("what an action means on a type", () => {
  it("gives a type that overrides nothing the default its kind inherits", () => {
    // The acceptance criterion in two lines: a hand-made leaf is checked
    // and a hand-made container is decomposed, with nobody having
    // written an override for either.
    expect(actionOverrideFor(registry, "refine", leaf)).toEqual(CLARIFIES);
    expect(actionOverrideFor(registry, "refine", container)).toEqual(DECOMPOSES);
  });

  it("prefers what the type itself says to what its kind would have said", () => {
    // The case the container flag could not express (ARCHITECTURE.md, "An item type is data"): a
    // leaf
    // whose `refine` produces children anyway, or one that answers in a
    // shape a pack invented.
    const decomposingLeaf: ActionSubject = { container: false, actionOverrides: { refine: DECOMPOSES } };

    expect(actionOverrideFor(registry, "refine", decomposingLeaf)).toEqual(DECOMPOSES);
  });

  it("says nothing about an action nobody has an opinion on, or about no type at all", () => {
    // Both answers are "use the action's own schema and the step's own
    // result key", which is what every action but `refine` does.
    expect(actionOverrideFor(registry, "implement", leaf)).toBeUndefined();
    expect(actionOverrideFor(registry, "refine")).toBeUndefined();
    expect(actionOverrideFor(emptyRegistry(), "refine", leaf)).toBeUndefined();
  });

  it("is not fooled by an action named after something every object has", () => {
    // The overrides arrive as a JSON object, and `constructor` is a word
    // somebody may name an action: answered by inheritance it would be a
    // shape nobody wrote and a poster nobody registered.
    expect(actionOverrideFor(registry, "constructor", leaf)).toBeUndefined();
    expect(actionOverrideFor(registry, "toString", container)).toBeUndefined();
  });

  it("treats a type nobody can find as a leaf that overrides nothing", () => {
    // A row deleted in another window. The conservative direction: work
    // is checked rather than a plan invented for it.
    expect(actionOverrideFor(registry, "refine", UNKNOWN_ITEM_TYPE)).toEqual(CLARIFIES);
  });

  it("names the schema a result is held to, which is the action's own where nothing overrides it", () => {
    expect(actionSchemaName(registry, "refine", leaf)).toBe("clarify");
    expect(actionSchemaName(registry, "refine", container)).toBe("refine");
    expect(actionSchemaName(registry, "refine")).toBe("refine");
    expect(actionSchemaName(registry, "implement", leaf)).toBe("implement");
  });

  it("resolves every action at once for a reader that has to carry the answers", () => {
    // What the prompt assembly hands a pack's section renderers: the
    // engine carries them and reads none of them.
    expect([...actionOverridesFor(registry, leaf)]).toEqual([["refine", CLARIFIES]]);
    expect([...actionOverridesFor(registry, container)]).toEqual([["refine", DECOMPOSES]]);
    expect([...actionOverridesFor(registry)]).toEqual([]);
  });

  it("keeps the defaults on the role that ships the action", () => {
    // Not on the item type and not in a constant of its own: the pack
    // that declares what `refine` answers with is the pack that says what
    // it means on a type that did not.
    expect(actionDefaultsFor(registry, "refine")).toEqual({ container: DECOMPOSES, leaf: CLARIFIES });
    expect(registry.roles.get("system")?.actionDefaults?.get("refine")).toBeDefined();
    expect(actionDefaultsFor(registry, "implement")).toBeUndefined();
  });

  it("ships the same two answers on the rows themselves, which is what the editor will show", () => {
    expect(registry.itemTypes.get("developer:feature")?.actionOverrides).toEqual({ refine: DECOMPOSES });
    expect(registry.itemTypes.get("developer:story")?.actionOverrides).toEqual({ refine: CLARIFIES });
    expect(registry.itemTypes.get("developer:bug")?.actionOverrides).toEqual({ refine: CLARIFIES });
  });
});

/**
 * And the load-time check (ARCHITECTURE.md, "An item type is data").
 *
 * An override is three names, and a name nothing can resolve is data in
 * appearance only: a run held to no shape at all, or one that finishes
 * and leaves nothing in the thread. The schema half is refused here,
 * where the registry is built; the poster half is refused where the packs
 * are folded, since a poster is a function a pack holds rather than
 * registry data.
 */
describe("building a registry whose overrides do not resolve", () => {
  const typed = (entry: ItemTypeEntry): Registry => ({
    roles: developerRegistry().roles,
    builtins: new Map(),
    itemTypes: new Map([[qualifiedItemType(entry), entry]]),
    packs: new Map(),
  });

  const CASE: ItemTypeEntry = {
    packSlug: "support",
    slug: "case",
    label: "Case",
    plural: "Cases",
    container: false,
    specShape: EMPTY_SPEC_SHAPE,
    actionOverrides: {},
  };

  it("refuses one naming a schema no role declares, and says which type and which action", () => {
    const wrong = { ...CASE, actionOverrides: { refine: { schema: "clarrify", resultKey: "clarified", poster: "clarification_note" } } };

    expect(() => buildRegistry(typed(wrong))).toThrow(/"support:case" item type/);
    expect(() => buildRegistry(typed(wrong))).toThrow(/"refine"/);
    expect(() => buildRegistry(typed(wrong))).toThrow(/"clarrify"/);
  });

  it("accepts one naming a schema some role does declare", () => {
    const right = { ...CASE, actionOverrides: { refine: { schema: "clarify", resultKey: "checked", poster: "clarification_note" } } };

    expect(() => buildRegistry(typed(right))).not.toThrow();
  });

  it("holds a role's defaults to the same rule", () => {
    const roles = new Map(developerRegistry().roles);
    const system = roles.get("system")!;
    roles.set("system", { ...system, actionDefaults: new Map([["refine", { container: { schema: "nobodys", resultKey: "decomposed", poster: "refine_proposal" }, leaf: CLARIFIES }]]) });

    expect(() => buildRegistry({ roles, builtins: new Map(), itemTypes: new Map(), packs: new Map() })).toThrow(/"system" role's default for a container/);
  });

  it("lists every override and default with who declared it, which is what both checks walk", () => {
    const declared = declaredActionOverrides(registry);

    expect(declared.filter((entry) => entry.declaredBy.includes("item type")).map((entry) => entry.declaredBy)).toEqual([
      'The "developer:feature" item type',
      'The "developer:story" item type',
      'The "developer:bug" item type',
    ]);
    expect(declared.filter((entry) => entry.declaredBy.includes("role")).map((entry) => entry.override)).toEqual([DECOMPOSES, CLARIFIES]);
  });
});
