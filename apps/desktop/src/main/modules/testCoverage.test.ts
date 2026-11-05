import { describe, expect, it } from "vitest";
import { characterCounts, commentMask, moduleCoverage, type V8FunctionCoverage } from "./testCoverage.js";

/**
 * The reduction from V8's report to two percentages (EO-352).
 *
 * Fed hand-written reports in V8's shape, so each rule can be held on
 * its own; `runModuleTests.test.ts` checks the same arithmetic against
 * what V8 really reports for a running module.
 */

/** The script's top level, which V8 reports as a function spanning the whole source. */
function topLevel(code: string, count = 1): V8FunctionCoverage {
  return { functionName: "", ranges: [{ startOffset: 0, endOffset: code.length, count }], isBlockCoverage: true };
}

function span(code: string, text: string): { startOffset: number; endOffset: number } {
  const startOffset = code.indexOf(text);
  if (startOffset === -1) throw new Error(`"${text}" is not in the code`);
  return { startOffset, endOffset: startOffset + text.length };
}

const CODE = [
  "// Says which way it went.",
  "export default function (ctx) {",
  "  if (ctx.left) {",
  "    return 'left';",
  "  }",
  "  return 'right';",
  "}",
  "function helper() {",
  "  return 1;",
  "}",
].join("\n");

/** A case where `left` was taken: the code after the `if` and `helper` never ran. */
function leftCase(): V8FunctionCoverage[] {
  const fn = span(CODE, "function (ctx) {\n  if (ctx.left) {\n    return 'left';\n  }\n  return 'right';\n}");
  const after = span(CODE, "\n  return 'right';\n");
  return [
    topLevel(CODE),
    { functionName: "default", ranges: [{ ...fn, count: 1 }, { ...after, count: 0 }], isBlockCoverage: true },
    { functionName: "helper", ranges: [{ ...span(CODE, "function helper() {\n  return 1;\n}"), count: 0 }], isBlockCoverage: false },
  ];
}

/** A case where `right` was taken: the `if`'s block never ran, and V8 says nothing about the code after it. */
function rightCase(): V8FunctionCoverage[] {
  const fn = span(CODE, "function (ctx) {\n  if (ctx.left) {\n    return 'left';\n  }\n  return 'right';\n}");
  const block = span(CODE, "{\n    return 'left';\n  }");
  return [
    topLevel(CODE),
    { functionName: "default", ranges: [{ ...fn, count: 1 }, { ...block, count: 0 }], isBlockCoverage: true },
    { functionName: "helper", ranges: [{ ...span(CODE, "function helper() {\n  return 1;\n}"), count: 0 }], isBlockCoverage: false },
  ];
}

describe("characterCounts", () => {
  it("lets the innermost range decide each character", () => {
    const counts = characterCounts(CODE.length, rightCase());
    expect(counts[CODE.indexOf("// Says")]).toBe(1);
    expect(counts[CODE.indexOf("return 'left'")]).toBe(0);
    expect(counts[CODE.indexOf("return 'right'")]).toBe(1);
    expect(counts[CODE.indexOf("return 1")]).toBe(0);
  });
});

describe("commentMask", () => {
  it("marks comments, and not comment-like text inside strings, templates or regular expressions", () => {
    const code = 'const a = "// no"; /* yes */ const b = `/* no ${"// no"} */`; const c = /\\/\\/ no/; // yes';
    const mask = commentMask(code);
    const marked = [...code].filter((_, index) => mask[index] === 1).join("");
    expect(marked).toBe("/* yes */// yes");
  });
});

describe("moduleCoverage", () => {
  it("counts lines with code on them, not comments or lone closing brackets", () => {
    // export…{, if…{, return 'left', return 'right', function helper…{, return 1.
    expect(moduleCoverage(CODE, [leftCase()]).lines.total).toBe(6);
  });

  it("covers a line when any code on it ran in any case", () => {
    expect(moduleCoverage(CODE, [leftCase()]).lines).toEqual({ covered: 3, total: 6, percent: 50 });
    expect(moduleCoverage(CODE, [rightCase()]).lines).toEqual({ covered: 3, total: 6, percent: 50 });
    expect(moduleCoverage(CODE, [leftCase(), rightCase()]).lines).toEqual({ covered: 4, total: 6, percent: 66.7 });
  });

  it("counts a branch one case reported and another ran unreported as covered", () => {
    // Left reports the code after the `if` (0) and right reports the
    // `if`'s block (0) — each is the branch the other took, which V8
    // leaves out of that case's report because it ran as often as the
    // function around it. Merging the reports would score both missed.
    const branches = moduleCoverage(CODE, [leftCase(), rightCase()]).branches;
    // The two arms and the entries of the two functions: `default`,
    // which ran, and `helper`, which never ran in either.
    expect(branches).toEqual({ covered: 3, total: 4, percent: 75 });
  });

  it("counts a function nobody called as a missed branch", () => {
    // `default`'s entry ran; the code after its `if` and `helper`'s entry did not.
    expect(moduleCoverage(CODE, [leftCase()]).branches).toEqual({ covered: 1, total: 3, percent: 33.3 });
  });

  it("is 0% with no report at all, and 100% of no branches once something ran", () => {
    expect(moduleCoverage(CODE, [])).toEqual({ lines: { covered: 0, total: 6, percent: 0 }, branches: { covered: 0, total: 0, percent: 0 } });
    const straight = "export default function () { return 1; }";
    expect(moduleCoverage(straight, [[topLevel(straight), { functionName: "default", ranges: [{ startOffset: 15, endOffset: straight.length, count: 1 }], isBlockCoverage: true }]])).toEqual({
      lines: { covered: 1, total: 1, percent: 100 },
      branches: { covered: 1, total: 1, percent: 100 },
    });
  });
});
