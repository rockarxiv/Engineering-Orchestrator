import { describe, expect, it } from "vitest";
import { codeSpan, cutKeepingCodeSpans } from "./codeSpan.js";

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

describe("cutKeepingCodeSpans (EO-830)", () => {
  const path = "C:\\Users\\name\\.eo\\repo\\.git\\hooks\\post-commit";
  const line = `Hooks at ${codeSpan(path)}, ${codeSpan(path)} stayed.`;

  it("leaves a line that already fits as it is", () => {
    expect(cutKeepingCodeSpans(line, line.length)).toBe(line);
  });

  it("cuts plain text where it is asked to", () => {
    expect(cutKeepingCodeSpans(line, 5)).toBe("Hooks");
  });

  it("closes a span the cut falls inside, within the limit", () => {
    const limit = line.indexOf(".git", line.lastIndexOf("`C:")) + 2;
    const cut = cutKeepingCodeSpans(line, limit);

    expect(cut.length).toBeLessThanOrEqual(limit);
    expect(cut).toBe(`${line.slice(0, limit - 1)}\``);
    expect(cut).toContain(codeSpan(path));
    expect(cut.split("`").length % 2).toBe(1);
  });

  it("drops a span whose opening fence the cut falls in, rather than leave a lone backtick", () => {
    const fenced = `see ${codeSpan("a`b")} here`;
    expect(cutKeepingCodeSpans(fenced, "see `".length)).toBe("see ");
  });

  it("drops backticks the span's own text ends in at the cut, which would close it early", () => {
    const fenced = `x ${codeSpan("ab`cd")}`;
    // "x ``ab`" kept, then the trailing backtick of the text dropped.
    expect(cutKeepingCodeSpans(fenced, "x ``ab`".length + 2)).toBe("x ``ab``");
  });

  it("does not treat an escaped backtick or an unclosed one as a span", () => {
    // \\` is a literal backtick, so `b` after it is no span and the cut stays where it was asked.
    expect(cutKeepingCodeSpans("a \\`b` and more", 5)).toBe("a \\`b");
    expect(cutKeepingCodeSpans("a lone ` tick here", 7)).toBe("a lone ");
    // A cut that ends in a literal backtick drops it: on its own it could pair with nothing, cut short it could pair with something.
    expect(cutKeepingCodeSpans("a lone `` tick here", 9)).toBe("a lone ");
  });
});
