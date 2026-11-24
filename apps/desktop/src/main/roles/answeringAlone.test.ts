import { describe, expect, it } from "vitest";
import { ALONE_END, ALONE_START, withoutAnsweringAlone } from "./answeringAlone.js";

describe("withoutAnsweringAlone (EO-888)", () => {
  it("leaves out every passage marked as for answering alone, markers and all, and keeps the rest as written", () => {
    const instructions = ["Review the change.", ALONE_START, "- Read the whole change.", "  Every file in the diff.", ALONE_END, "- Judge correctness.", `  ${ALONE_START}`, "- Give one verdict.", `${ALONE_END}  `, "- Be specific."].join("\n");
    expect(withoutAnsweringAlone(instructions)).toBe(["Review the change.", "- Judge correctness.", "- Be specific."].join("\n"));
  });

  it("leaves instructions with no marker as they are", () => {
    const instructions = "<!-- prompt-version: 3 -->\nDo the work.\n\n- Carefully.\n";
    expect(withoutAnsweringAlone(instructions)).toBe(instructions);
  });

  it("takes only the line of a start with no end after it, never the rest of the instructions", () => {
    expect(withoutAnsweringAlone(["Before.", ALONE_START, "After."].join("\n"))).toBe("Before.\nAfter.");
    expect(withoutAnsweringAlone(["Before.", ALONE_END, "After."].join("\n"))).toBe("Before.\nAfter.");
  });
});
