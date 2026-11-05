import { describe, expect, it } from "vitest";
import {
  isPackShipped,
  itemTypeDraftProblem,
  itemTypeHoldsItemsMessage,
  itemTypeOptionLabel,
  LOCAL_PACK,
  packItemTypeEditRefusal,
  specFieldDrafts,
  specShapeFromFields,
  toSlug,
  type SpecFieldDraft,
} from "./itemTypeAuthoring.js";
import { developerRegistry } from "./registry/developer.js";
import { parseQualifiedItemType, qualifiedItemType } from "./registry/index.js";
import { missingSpecFields, specFields, specIssues } from "./schemas/specShape.js";

/** The story's own example: a Case with a required customer and an optional channel. */
const CASE_FIELDS: SpecFieldDraft[] = [
  { name: "customer", kind: "string", required: true },
  { name: "channel", kind: "string", required: false },
];

describe("compiling a hand-made type's fields into a spec shape (§7.5, KAN-164)", () => {
  it("names the required fields in `required` and leaves the optional ones alone", () => {
    const shape = specShapeFromFields(CASE_FIELDS);

    expect(shape).toEqual({
      type: "object",
      properties: {
        customer: { type: "string", minLength: 1 },
        channel: { type: "string" },
      },
      required: ["customer"],
    });
  });

  it("refuses a Case with no customer, by the shape rather than by a check anybody wrote", () => {
    const shape = specShapeFromFields(CASE_FIELDS);

    expect(specIssues(shape, { channel: "email" })).not.toEqual([]);
    // And says which field to supply, which is what the refusal a person
    // reads is made of.
    expect(missingSpecFields(shape, { channel: "email" }).map((field) => field.name)).toEqual(["customer"]);
    expect(specIssues(shape, { customer: "Acme" })).toEqual([]);
  });

  it("holds a required field to being non-empty, exactly as the pack's own shapes do", () => {
    const shape = specShapeFromFields(CASE_FIELDS);

    // `required` alone would let `""` through — the key is there. Every
    // shape the developer pack ships says otherwise with `minLength`, and
    // a hand-made type is held to the same bar or "required" means two
    // different things on one screen.
    expect(missingSpecFields(shape, { customer: "" }).map((field) => field.name)).toEqual(["customer"]);
  });

  it("compiles each of the four kinds, and demands nothing of an optional one", () => {
    const shape = specShapeFromFields([
      { name: "seats", kind: "number", required: false },
      { name: "urgent", kind: "boolean", required: false },
      { name: "tags", kind: "string list", required: true },
      { name: "notes", kind: "string list", required: false },
    ]);

    expect(shape.properties).toEqual({
      seats: { type: "number" },
      urgent: { type: "boolean" },
      tags: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
      notes: { type: "array", items: { type: "string" } },
    });
    expect(specIssues(shape, { tags: ["billing"], notes: [] })).toEqual([]);
    expect(missingSpecFields(shape, { tags: [] }).map((field) => field.name)).toEqual(["tags"]);
  });

  it("keeps the order the fields were written in, because that is the order they are drawn in", () => {
    expect(specFields(specShapeFromFields(CASE_FIELDS)).map((field) => field.name)).toEqual(["customer", "channel"]);
  });

  it("reads a shape back into the form's fields, including a pack's", () => {
    expect(specFieldDrafts(specShapeFromFields(CASE_FIELDS))).toEqual(CASE_FIELDS);

    const story = developerRegistry().itemTypes.get("developer:story")!;
    expect(specFieldDrafts(story.specShape)).toEqual([{ name: "acceptance_criteria", kind: "string list", required: true }]);
  });
});

describe("what a person may type", () => {
  it("makes a key out of whatever was written", () => {
    expect(toSlug("Case")).toBe("case");
    expect(toSlug("  Customer name  ")).toBe("customer_name");
    expect(toSlug("Support/Case")).toBe("support_case");
    expect(toSlug("!!!")).toBe("");
  });

  it("refuses a draft with nothing to file items under, and says which part is wrong", () => {
    expect(itemTypeDraftProblem({ label: "", plural: "Cases", fields: [] })).toContain("needs a name");
    expect(itemTypeDraftProblem({ label: "Case", plural: " ", fields: [] })).toContain("plural");
    expect(itemTypeDraftProblem({ label: "!!!", plural: "!!!s", fields: [] })).toContain("no letters or digits");
    expect(itemTypeDraftProblem({ label: "Case", plural: "Cases", fields: [{ name: " ", kind: "string", required: false }] })).toContain(
      "Every field needs a name",
    );
  });

  it("catches two fields that would become one key before the insert does", () => {
    const problem = itemTypeDraftProblem({
      label: "Case",
      plural: "Cases",
      fields: [
        { name: "Customer", kind: "string", required: true },
        { name: "customer", kind: "string", required: false },
      ],
    });

    expect(problem).toContain("customer");
  });

  it("passes the story's own example", () => {
    expect(itemTypeDraftProblem({ label: "Case", plural: "Cases", fields: CASE_FIELDS })).toBeNull();
  });
});

describe("what the editor may change, and what it may not", () => {
  it("tells a pack's type from one somebody made here", () => {
    expect(isPackShipped({ packSlug: "developer" })).toBe(true);
    expect(isPackShipped({ packSlug: LOCAL_PACK })).toBe(false);
  });

  it("says what a pack's type may still be called, when refusing to reshape it", () => {
    const refusal = packItemTypeEditRefusal({ label: "Story", packSlug: "developer" });

    expect(refusal).toContain("Story");
    expect(refusal).toContain("developer");
    expect(refusal).toContain("rename");
  });
});

describe("refusing to delete a type that has items", () => {
  it("names the count, and names 1 as 1", () => {
    expect(itemTypeHoldsItemsMessage({ label: "Case", plural: "Cases" }, 1)).toContain("1 item");
    expect(itemTypeHoldsItemsMessage({ label: "Case", plural: "Cases" }, 3)).toContain("3 cases");
  });

  it("says nothing at all about a type nothing points at", () => {
    expect(itemTypeHoldsItemsMessage({ label: "Case", plural: "Cases" }, 0)).toBeNull();
  });
});

describe("naming which type, where a word has two answers", () => {
  it("reads a qualified spelling back into the pair the resolver takes", () => {
    expect(parseQualifiedItemType("developer:story")).toEqual({ packSlug: "developer", slug: "story" });
    expect(parseQualifiedItemType(`${LOCAL_PACK}:case`)).toEqual({ packSlug: LOCAL_PACK, slug: "case" });
  });

  it("round-trips whatever `qualifiedItemType` wrote", () => {
    const ref = { packSlug: "support", slug: "case" };

    expect(parseQualifiedItemType(qualifiedItemType(ref))).toEqual(ref);
  });

  it("answers null for a bare word rather than inventing a pack for it", () => {
    // The caller then has a slug, which `resolveItemType` will either
    // answer or refuse as ambiguous — both better than this guessing
    // which of two packs was meant.
    expect(parseQualifiedItemType("case")).toBeNull();
    expect(parseQualifiedItemType(":case")).toBeNull();
    expect(parseQualifiedItemType("support:")).toBeNull();
  });
});

describe("offering a type by its label", () => {
  const types = [
    { label: "Story", packSlug: "developer" },
    { label: "Case", packSlug: "support" },
    { label: "Case", packSlug: LOCAL_PACK },
  ];

  it("uses the label alone where it is the only one", () => {
    expect(itemTypeOptionLabel(types[0]!, types)).toBe("Story");
  });

  it("names the pack where two types answer to one label", () => {
    expect(itemTypeOptionLabel(types[1]!, types)).toBe("Case (support)");
    expect(itemTypeOptionLabel(types[2]!, types)).toBe("Case (local)");
  });
});
