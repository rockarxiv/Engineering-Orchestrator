import { describe, expect, it } from "vitest";
import { codeSpan } from "./codeSpan.js";

describe("codeSpan (EO-830)", () => {
  it("fences a Windows path in single backticks, backslashes untouched", () => {
    expect(codeSpan("C:\\Users\\name\\.eo\\codex-homes")).toBe("`C:\\Users\\name\\.eo\\codex-homes`");
  });

  it("fences text holding backticks with a run longer than any inside it", () => {
    expect(codeSpan("a`b``c")).toBe("```a`b``c```");
  });

  it("pads text that starts or ends with a backtick or a space, which the renderer strips again", () => {
    expect(codeSpan("`tick")).toBe("`` `tick ``");
    expect(codeSpan("tick`")).toBe("`` tick` ``");
    expect(codeSpan(" spaced ")).toBe("`  spaced  `");
  });

  it("writes line endings as the spaces a code span renders them as, so a blank line cannot end it", () => {
    expect(codeSpan("fatal: one\n\nC:\\repo\\.git\r\nend")).toBe("`fatal: one  C:\\repo\\.git end`");
  });

  it("writes nothing for nothing: two backticks alone are not a code span", () => {
    expect(codeSpan("")).toBe("");
  });
});
