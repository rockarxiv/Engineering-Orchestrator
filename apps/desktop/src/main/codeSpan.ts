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
