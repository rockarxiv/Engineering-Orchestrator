/**
 * Text as a markdown code span, which renders exactly as it is written
 * (EO-830).
 *
 * Comments are rendered as markdown, where a backslash before ASCII
 * punctuation is an escape. A Windows path EO writes into a comment as
 * plain text therefore loses every backslash before a `.`, `-` or `_`:
 * `C:\Users\name\.eo` shows as `C:\Users\name.eo`, which is another
 * path. Inside a code span nothing is an escape, so a path EO puts into
 * a comment of its own — or a Node error message, which quotes the path
 * again — goes through this. What people and agents write is left as
 * they wrote it: their own backslash escapes are deliberate.
 *
 * The fence is one backtick longer than the longest run in the text, so
 * nothing inside can close it, and a text that starts or ends with a
 * backtick or a space is padded with one space each side, which the
 * renderer strips again (CommonMark, "Code spans").
 *
 * Line endings are written as the spaces a code span renders them as
 * anyway. A blank line in an error git printed would otherwise end the
 * paragraph and the code span with it, leaving the rest as markdown —
 * and a reason that is cut to its first line before it reaches a
 * comment (`sayable`) would be cut inside the span.
 */
export function codeSpan(text: string): string {
  if (text === "") return "";
  const line = text.replace(/\r\n|\r|\n/g, " ");
  const longest = Math.max(0, ...[...line.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = "`".repeat(longest + 1);
  const padded = /^[` ]|[` ]$/.test(line) ? ` ${line} ` : line;
  return `${ticks}${padded}${ticks}`;
}

/**
 * The first `limit` characters of one line of markdown, or fewer, cut so
 * that no code span is left open (EO-830).
 *
 * A reason bounded by length (`sayable`) can be cut inside a path
 * `codeSpan` wrote. A span with no closing fence is not a span at all —
 * its opening backticks become literal and every backslash in the rest of
 * the path is an escape again. So a cut that falls inside a span keeps as
 * much of the span's text as fits and closes it with its own fence; a cut
 * inside the opening fence drops the span instead. Backticks at the end of
 * what is kept are dropped too, because they could close the span early
 * or open a new one.
 *
 * What comes back is never longer than `limit`, so the bound the caller
 * keeps is the bound it asked for.
 */
export function cutKeepingCodeSpans(line: string, limit: number): string {
  if (line.length <= limit) return line;
  const span = codeSpans(line).find((found) => found.open < limit && limit < found.end);
  if (span === undefined) return line.slice(0, limit).replace(/`+$/, "");

  const fence = span.contentStart - span.open;
  const kept = line.slice(span.contentStart, Math.min(limit - fence, span.contentEnd)).replace(/`+$/, "");
  if (kept.trim() === "") return line.slice(0, span.open).replace(/`+$/, "");
  return `${line.slice(0, span.contentStart)}${kept}${"`".repeat(fence)}`;
}

/** Where each code span in a line of markdown is, as CommonMark reads it. */
function codeSpans(line: string): { open: number; contentStart: number; contentEnd: number; end: number }[] {
  const spans: { open: number; contentStart: number; contentEnd: number; end: number }[] = [];
  let at = 0;
  while (at < line.length) {
    const char = line[at];
    if (char === "\\") {
      // An escaped backtick is a literal one, and opens nothing.
      at += 2;
      continue;
    }
    if (char !== "`") {
      at += 1;
      continue;
    }
    const fence = runAt(line, at);
    // The span closes at the next run of exactly as many backticks; with
    // none, the opening run is literal text.
    let close = at + fence;
    while (close < line.length) {
      if (line[close] === "`") {
        const run = runAt(line, close);
        if (run === fence) break;
        close += run;
      } else {
        close += 1;
      }
    }
    if (close >= line.length) {
      at += fence;
      continue;
    }
    spans.push({ open: at, contentStart: at + fence, contentEnd: close, end: close + fence });
    at = close + fence;
  }
  return spans;
}

function runAt(line: string, at: number): number {
  let end = at;
  while (line[end] === "`") end += 1;
  return end - at;
}
