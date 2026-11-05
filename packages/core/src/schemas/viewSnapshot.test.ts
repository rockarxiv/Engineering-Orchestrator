import { describe, expect, it } from "vitest";
import { ViewSnapshotSchema } from "./viewSnapshot.js";

/**
 * What the renderer is allowed to say (EO-192).
 *
 * The value of this shape is in what it will not carry, so most of what
 * is asserted here is a refusal. A field for a sentence about an item
 * is a field somebody eventually fills, and the agent then acts on a
 * description the side of the app with no database wrote.
 */
const PAGE = { route: "/items/:itemId", params: { itemId: "019fb8c6-de92-7a41-9c33-4471f0c2b1de" } };

describe("a published view", () => {
  it("needs only a page — a screen with no filter, no selection and no sort is a real screen", () => {
    const parsed = ViewSnapshotSchema.parse({ page: PAGE });

    expect(parsed.filter).toBeNull();
    expect(parsed.selection).toEqual([]);
    expect(parsed.sort).toBeNull();
    expect(parsed.unsavedEdits).toEqual([]);
  });

  it("keeps the filter exactly as it was typed", () => {
    // Not trimmed and not lowercased here: what the person typed is the
    // view parameter, and how it is matched is the handler's business.
    const parsed = ViewSnapshotSchema.parse({ page: PAGE, filter: { text: "  Rate ", facets: { type: "bug" } } });

    expect(parsed.filter?.text).toBe("  Rate ");
    expect(parsed.filter?.facets["type"]).toBe("bug");
  });

  it("drops anything the renderer tries to say beyond identifiers and view parameters", () => {
    const parsed = ViewSnapshotSchema.parse({
      page: PAGE,
      // The failure this shape exists to prevent, written out: a
      // renderer describing the item, and a renderer asserting what
      // its own filter matched.
      summary: "You are on EO-42, which is in review.",
      matchingItems: [{ key: "EO-42" }],
    });

    expect(parsed).not.toHaveProperty("summary");
    expect(parsed).not.toHaveProperty("matchingItems");
  });

  it("refuses a sort that is not a column and a direction", () => {
    // `<column>:asc|desc`, so the answer can print it without having to
    // decide whether "newest first, mostly" is an ordering or a
    // sentence.
    expect(ViewSnapshotSchema.safeParse({ page: PAGE, sort: "updated:desc" }).success).toBe(true);
    expect(ViewSnapshotSchema.safeParse({ page: PAGE, sort: "whatever the user likes" }).success).toBe(false);
  });

  it("takes an unsaved edit as a field and what is in it", () => {
    const parsed = ViewSnapshotSchema.parse({ page: PAGE, unsavedEdits: [{ field: "Base branch", value: "release/next" }] });

    expect(parsed.unsavedEdits).toEqual([{ field: "Base branch", value: "release/next" }]);
  });

  it("refuses an unsaved edit longer than a publisher should have sent", () => {
    // Capped rather than truncated here, because silently shortening at
    // the boundary would make the publisher's own truncation untestable.
    expect(ViewSnapshotSchema.safeParse({ page: PAGE, unsavedEdits: [{ field: "Instructions", value: "x".repeat(5_000) }] }).success).toBe(false);
  });

  it("refuses a payload with no page at all", () => {
    expect(ViewSnapshotSchema.safeParse({ filter: { text: "rate", facets: {} } }).success).toBe(false);
  });
});
