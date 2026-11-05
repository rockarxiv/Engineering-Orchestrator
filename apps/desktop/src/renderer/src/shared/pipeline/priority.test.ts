import { describe, expect, it } from "vitest";
import { priorityLabel, priorityTone, showsPriorityBadge } from "./priority";

describe("how a priority is shown", () => {
  it("colours only the ends, and the card and the item agree because both ask this", () => {
    // The item header used to render every priority amber, so the
    // same item was red on the project and amber on its own page.
    expect(priorityTone(0)).toBe("neutral");
    expect(priorityTone(1)).toBe("warning");
    expect(priorityTone(2)).toBe("danger");
    expect(priorityTone(9)).toBe("danger");
  });

  it("names the level rather than ranking it", () => {
    expect(priorityLabel(1)).toBe("High");
    expect(priorityLabel(2)).toBe("Urgent");
  });

  it("still renders a value with no name", () => {
    // An open integer: the scheduler sorts descending and does not care
    // that we only named three of them.
    expect(priorityLabel(7)).toBe("Priority 7");
  });

  it("says nothing at all about a normal item", () => {
    expect(showsPriorityBadge(0)).toBe(false);
    expect(showsPriorityBadge(1)).toBe(true);
  });
});
