import { describe, expect, it } from "vitest";
import { stepHoldsItemsMessage } from "./stepHolds.js";

/**
 * The one sentence for a step that cannot go (EO-230), read by the
 * editor beside the step, by Publish, and by the repository under both.
 * Pinned word for word because three places say it: a person who meets
 * the same fact spelled three ways believes they have three problems.
 */
describe("what a step holding items is refused with", () => {
  it("names the step and counts, in the singular and the plural", () => {
    expect(stepHoldsItemsMessage({ stepName: "Reviewer", count: 2, archived: 0 })).toBe("Reviewer has 2 items on it. Move them before removing the step.");
    expect(stepHoldsItemsMessage({ stepName: "Reviewer", count: 1, archived: 0 })).toBe("Reviewer has 1 item on it. Move it before removing the step.");
  });

  /**
   * An archived item counts — the foreign key holds — but is not on the
   * board to be moved, so the sentence says where the path actually
   * starts rather than sending somebody to a board with nothing on it.
   */
  it("says which of them are archived, and that those are restored first", () => {
    expect(stepHoldsItemsMessage({ stepName: "Reviewer", count: 1, archived: 1 })).toBe(
      "Reviewer has 1 item on it. Move it before removing the step. It is archived — restore it first.",
    );
    expect(stepHoldsItemsMessage({ stepName: "Reviewer", count: 2, archived: 2 })).toBe(
      "Reviewer has 2 items on it. Move them before removing the step. All of them are archived — restore them first.",
    );
    expect(stepHoldsItemsMessage({ stepName: "Reviewer", count: 3, archived: 1 })).toBe(
      "Reviewer has 3 items on it. Move them before removing the step. 1 of them is archived — restore it first.",
    );
    expect(stepHoldsItemsMessage({ stepName: "Reviewer", count: 3, archived: 2 })).toBe(
      "Reviewer has 3 items on it. Move them before removing the step. 2 of them are archived — restore them first.",
    );
  });
});
