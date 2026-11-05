import type { CoverageFigure } from "@eo/core";

/**
 * V8's coverage of a module, turned into the two figures a person reads
 * (EO-352).
 *
 * Each test case runs in its own host, and each host hands back V8's
 * precise block coverage for the module's script alone — never for the
 * case's. This folds every case's report into one line percentage and
 * one branch percentage, so a line one case reaches and another does not
 * counts as covered.
 *
 * Pure: offsets in, figures out. No new dependency — the reduction
 * c8 and `v8-to-istanbul` do is small enough to own, and doing it here
 * lets the aggregation be better than a merge of separate reports could
 * be (see `branchFigure`).
 */

/** One range of V8's block coverage: `count` executions of `[startOffset, endOffset)`. */
export interface V8CoverageRange {
  startOffset: number;
  endOffset: number;
  count: number;
}

/** One function in V8's report. The first range is the function itself; the rest are blocks inside it. */
export interface V8FunctionCoverage {
  functionName: string;
  ranges: V8CoverageRange[];
  isBlockCoverage: boolean;
}

/** The two figures, as `ModuleTestRun.coverage` holds them. */
export interface ModuleCoverage {
  lines: CoverageFigure;
  branches: CoverageFigure;
}

/** A percentage to one decimal place. */
function percentOf(covered: number, total: number, measured: boolean): number {
  if (total === 0) return measured ? 100 : 0;
  return Math.round((covered / total) * 1000) / 10;
}

/**
 * How many times each character of the source ran, in one case.
 *
 * The innermost range containing a character decides it, which is how
 * V8 means its report to be read: a block's count overrides the
 * function's around it, and a function's overrides the script's. Outer
 * ranges are applied first and inner ones over them — sorted by length,
 * and stable, so a block that shares its extent with its function (V8
 * reports both) still wins, coming later in the report.
 */
export function characterCounts(length: number, functions: readonly V8FunctionCoverage[]): Float64Array {
  const counts = new Float64Array(length);
  const ranges = functions.flatMap((fn) => fn.ranges).filter((range) => range.endOffset > range.startOffset);
  const ordered = ranges.map((range, index) => ({ range, index })).sort((a, b) => b.range.endOffset - b.range.startOffset - (a.range.endOffset - a.range.startOffset) || a.index - b.index);
  for (const { range } of ordered) counts.fill(range.count, Math.max(0, range.startOffset), Math.min(length, range.endOffset));
  return counts;
}

/**
 * Which characters are inside a comment.
 *
 * A small lexer rather than a parser: it knows strings, templates (with
 * their substitutions), regular expressions and both kinds of comment,
 * which is all it takes to tell a comment from code. Where it guesses —
 * whether a `/` divides or opens a regular expression — a wrong guess
 * costs a line being counted or not, never a wrong count.
 */
export function commentMask(code: string): Uint8Array {
  const mask = new Uint8Array(code.length);
  /** For each open `${`, the brace depth inside it, so its `}` is found. */
  const templates: number[] = [];
  let depth = 0;
  let previous = "";
  let at = 0;

  const regexMayFollow = (): boolean => previous === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(previous) || /^(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(previous);

  const skipTemplate = (): void => {
    // At the character after the opening backtick or after a closing `}`.
    while (at < code.length) {
      const char = code[at];
      if (char === "\\") {
        at += 2;
        continue;
      }
      if (char === "`") {
        at += 1;
        return;
      }
      if (char === "$" && code[at + 1] === "{") {
        at += 2;
        templates.push(depth);
        return;
      }
      at += 1;
    }
  };

  while (at < code.length) {
    const char = code[at]!;
    const next = code[at + 1];
    if (char === "/" && next === "/") {
      const end = code.slice(at).search(/[\n\r\u2028\u2029]/);
      const stop = end === -1 ? code.length : at + end;
      mask.fill(1, at, stop);
      at = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = code.indexOf("*/", at + 2);
      const stop = close === -1 ? code.length : close + 2;
      mask.fill(1, at, stop);
      at = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      at += 1;
      while (at < code.length && code[at] !== char && code[at] !== "\n") at += code[at] === "\\" ? 2 : 1;
      at += 1;
      previous = "a";
      continue;
    }
    if (char === "`") {
      at += 1;
      skipTemplate();
      previous = "a";
      continue;
    }
    if (char === "/" && regexMayFollow()) {
      let inClass = false;
      at += 1;
      while (at < code.length && code[at] !== "\n") {
        const inside = code[at];
        if (inside === "\\") {
          at += 2;
          continue;
        }
        if (inside === "[") inClass = true;
        else if (inside === "]") inClass = false;
        else if (inside === "/" && !inClass) break;
        at += 1;
      }
      at += 1;
      previous = "a";
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        at += 1;
        skipTemplate();
        previous = "a";
        continue;
      }
      depth -= 1;
    }
    if (/\s/.test(char)) {
      at += 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(char)) {
      let end = at;
      while (end < code.length && /[A-Za-z0-9_$]/.test(code[end]!)) end += 1;
      previous = code.slice(at, end);
      at = end;
      continue;
    }
    previous = char;
    at += 1;
  }
  return mask;
}

/** Where each line starts and ends, in every spelling JavaScript has for a line ending. */
function lineSpans(code: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  for (let at = 0; at < code.length; at += 1) {
    const char = code[at];
    if (char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029") {
      spans.push([start, at]);
      if (char === "\r" && code[at + 1] === "\n") at += 1;
      start = at + 1;
    }
  }
  spans.push([start, code.length]);
  return spans;
}

/** Characters that on their own make no statement: a line of nothing else is not counted. */
const PUNCTUATION_ONLY = /^[{}()[\];,]$/;

/**
 * Line coverage over every case's counts.
 *
 * A line counts when it has code on it — something other than
 * whitespace, a comment, or the brackets and semicolons that close what
 * an earlier line opened. It is covered when any of that code ran in
 * any case.
 */
function lineFigure(code: string, perCase: Float64Array[]): CoverageFigure {
  const comments = commentMask(code);
  let covered = 0;
  let total = 0;
  for (const [start, end] of lineSpans(code)) {
    let counted = false;
    let ran = false;
    for (let at = start; at < end; at += 1) {
      const char = code[at]!;
      if (comments[at] === 1 || /\s/.test(char)) continue;
      if (!PUNCTUATION_ONLY.test(char)) counted = true;
      if (!ran && perCase.some((counts) => (counts[at] ?? 0) > 0)) ran = true;
    }
    if (!counted) continue;
    total += 1;
    if (ran) covered += 1;
  }
  return { covered, total, percent: percentOf(covered, total, perCase.length > 0) };
}

/**
 * Branch coverage over every case's report.
 *
 * A branch is a block V8 reported — the arm of an `if`, a `case`, the
 * right of a `&&`, a `catch` — plus each function other than the
 * script's top level, whose entry is a branch too: V8 says nothing about
 * the blocks inside a function that never ran, so without this a module
 * whose untested half is a whole function would read as fully branched.
 *
 * V8 only reports a block whose count differs from the one around it,
 * so one case's report never lists every branch. The set is the union
 * over every case, and whether a branch ran in a case that did not list
 * it is read from that case's character counts, which carry the count of
 * the block around it — the count the omitted block had. Merging
 * separate reports, which is what c8 does across files, would score a
 * branch one case reported as missed and another ran unreported as
 * missed; this scores it as run.
 */
function branchFigure(code: string, reports: ReadonlyArray<readonly V8FunctionCoverage[]>, perCase: Float64Array[]): CoverageFigure {
  const branches = new Map<string, number>();
  const reported: Array<Map<string, number>> = reports.map(() => new Map());
  reports.forEach((functions, index) => {
    for (const fn of functions) {
      const [first, ...blocks] = fn.ranges;
      if (first === undefined) continue;
      const topLevel = first.startOffset === 0 && first.endOffset >= code.length;
      const candidates = [...(topLevel ? [] : [first]), ...(fn.isBlockCoverage ? blocks : [])];
      for (const range of candidates) {
        const key = `${range.startOffset}:${range.endOffset}`;
        branches.set(key, range.startOffset);
        reported[index]!.set(key, range.count);
      }
    }
  });

  let covered = 0;
  for (const [key, start] of branches) {
    const ran = reported.some((counts, index) => (counts.get(key) ?? perCase[index]![start] ?? 0) > 0);
    if (ran) covered += 1;
  }
  return { covered, total: branches.size, percent: percentOf(covered, branches.size, reports.length > 0) };
}

/**
 * Line and branch coverage of `code` across every case's report.
 *
 * `reports` holds one entry per case that produced one; a case that was
 * killed, or never loaded the module, contributes nothing. With no
 * report at all both figures are 0% — nothing of the module ran.
 */
export function moduleCoverage(code: string, reports: ReadonlyArray<readonly V8FunctionCoverage[]>): ModuleCoverage {
  const perCase = reports.map((functions) => characterCounts(code.length, functions));
  return { lines: lineFigure(code, perCase), branches: branchFigure(code, reports, perCase) };
}
