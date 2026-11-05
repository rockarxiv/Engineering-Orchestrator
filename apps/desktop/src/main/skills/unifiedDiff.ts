/**
 * A unified diff of two texts, line by line (EO-483).
 *
 * What an improvement proposal attaches beside its SKILL.md, so a person
 * can see what Save would change in the skill rather than reading two
 * whole files side by side. Written here rather than taken from a
 * library: a SKILL.md is a few hundred lines at most, a longest common
 * subsequence over that is instant, and the one consumer needs nothing
 * a library would add.
 *
 * The output is the ordinary `--- a` / `+++ b` / `@@` form that every
 * diff viewer reads, with three lines of context. Identical texts give
 * the two header lines and no hunk.
 */
export function unifiedDiff(before: string, after: string, names: { from: string; to: string }, context = 3): string {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffLines(a, b);
  const out = [`--- ${names.from}`, `+++ ${names.to}`];

  // Indices into `ops` that change something; hunks gather around them.
  const changed = ops.flatMap((op, index) => (op.kind === "same" ? [] : [index]));
  let at = 0;
  while (at < changed.length) {
    const start = Math.max(0, changed[at]! - context);
    let end = Math.min(ops.length, changed[at]! + context + 1);
    while (at + 1 < changed.length && changed[at + 1]! - context <= end) {
      at += 1;
      end = Math.min(ops.length, changed[at]! + context + 1);
    }
    at += 1;
    const slice = ops.slice(start, end);
    const first = ops[start]!;
    const fromCount = slice.filter((op) => op.kind !== "add").length;
    const toCount = slice.filter((op) => op.kind !== "remove").length;
    out.push(`@@ -${rangeStart(first.aIndex, fromCount)},${fromCount} +${rangeStart(first.bIndex, toCount)},${toCount} @@`);
    for (const op of slice) out.push(`${op.kind === "same" ? " " : op.kind === "add" ? "+" : "-"}${op.line}`);
  }
  return `${out.join("\n")}\n`;
}

type Op = { kind: "same" | "add" | "remove"; line: string; aIndex: number; bIndex: number };

/** A hunk's 1-based start, which is the line before it when it covers no lines at all. */
function rangeStart(index: number, count: number): number {
  return count === 0 ? index : index + 1;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The edit script from `a` to `b`, by a longest common subsequence. Each op carries where it stands in both. */
function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] = a[i] === b[j] ? lcs[(i + 1) * cols + j + 1]! + 1 : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: "same", line: a[i]!, aIndex: i, bIndex: j });
      i += 1;
      j += 1;
    } else if (i < a.length && (j === b.length || lcs[(i + 1) * cols + j]! >= lcs[i * cols + j + 1]!)) {
      // A removal before the addition that replaces it, as every diff reads.
      ops.push({ kind: "remove", line: a[i]!, aIndex: i, bIndex: j });
      i += 1;
    } else {
      ops.push({ kind: "add", line: b[j]!, aIndex: i, bIndex: j });
      j += 1;
    }
  }
  return ops;
}
