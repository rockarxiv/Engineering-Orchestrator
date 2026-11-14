import { describe, expect, it } from "vitest";
import { RecordItemWaitsSchema } from "./index.js";

/**
 * An item's edges as the record sends them, with the rule each waits by
 * (EO-778). The rules travel beside the two lists of ids, so a page from
 * either side of the change still reads.
 */
describe("an item's edges on the wire", () => {
  it("reads a page from a record that predates rules as every edge waiting to finish", () => {
    expect(RecordItemWaitsSchema.parse({ dependsOn: ["a"], blocks: [] })).toEqual({ dependsOn: ["a"], blocks: [], gates: [] });
  });

  it("carries each edge's rule and step, and reads a rule it has no word for as finished", () => {
    const parsed = RecordItemWaitsSchema.parse({
      dependsOn: ["a", "b"],
      blocks: [],
      gates: [
        { itemId: "x", dependsOnId: "a", wait: "reached", step: { id: "review", name: "Review" } },
        { itemId: "x", dependsOnId: "b", wait: "someday", step: null },
      ],
    });

    expect(parsed.gates).toEqual([
      { itemId: "x", dependsOnId: "a", wait: "reached", step: { id: "review", name: "Review" } },
      { itemId: "x", dependsOnId: "b", wait: "finished", step: null },
    ]);
  });
});
