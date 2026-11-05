/*
 * Markdown's block parser: source text in, a list of blocks out — no
 * React, nothing rendered. Its own module so that `Markdown` can keep the
 * parse it made for a source and a test can tell when it parses again
 * (EO-551): a streamed chat re-renders its rows many times a second, and
 * re-parsing every message on each frame was most of the cost.
 */

export interface Block {
  kind: "code" | "quote" | "ul" | "ol" | "heading" | "p" | "table" | "rule";
  lines: string[];
  level?: number;
  lang?: string;
  /** A table's column alignments, one per column, from its separator row. */
  align?: ("left" | "center" | "right" | null)[];
}

/**
 * A table's separator row: `| --- | :---: | ---: |`, the pipes at either
 * end optional but at least one pipe somewhere — a bare `---` under a line
 * is a rule (or, in CommonMark, an underlined heading), never a table.
 */
const TABLE_SEPARATOR = /^(?=[^|]*\|)\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
/** A thematic break: three or more of one of `-`, `*` or `_`, nothing else. */
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** One table row's cells, the outer pipes dropped. An escaped `\|` is a pipe in a cell, not a border. */
export function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function startsTable(lines: readonly string[], index: number): boolean {
  const line = lines[index];
  const next = lines[index + 1];
  return line !== undefined && next !== undefined && line.includes("|") && TABLE_SEPARATOR.test(next) && tableCells(line).length === tableCells(next).length;
}

/**
 * A fence, and how long it is.
 *
 * The length is the whole point (EO-311). A block opened with four
 * backticks is closed by four, not by the three-backtick line inside it —
 * which is exactly the shape EO posts a diff of a documentation file in:
 * `composeOutputBody` counts the longest run of backticks in the diff and
 * fences it with one more, precisely so the embedded fences cannot end
 * it. A parser that closed on any ``` undid that at the last step, and
 * the rest of the diff rendered as prose on the item page.
 *
 * Backticks only, as before. Tilde fences are a fence in CommonMark and
 * are not one here, because nothing in EO writes one and a line of three
 * tildes in somebody's prose should not silently become code.
 */
const OPENS_A_FENCE = /^(`{3,})(.*)$/;

/**
 * Whether this line ends a block opened with `delimiter`.
 *
 * At least as long as the opening run, and nothing after it but space —
 * CommonMark's rule, and the one that makes a nested ```` ```ts ```` line
 * content rather than a closing fence. An unterminated block still
 * renders to the end of the text, which is the older promise this keeps.
 */
function closes(line: string, delimiter: string): boolean {
  const found = /^(`{3,})\s*$/.exec(line);
  return found !== null && found[1]!.length >= delimiter.length;
}

export function toBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    const fence = OPENS_A_FENCE.exec(line);
    if (fence) {
      const delimiter = fence[1]!;
      const lang = fence[2]!.trim();
      const body: string[] = [];
      index++;
      while (index < lines.length && !closes(lines[index]!, delimiter)) body.push(lines[index++]!);
      index++; // closing fence, if present — an unterminated block still renders
      blocks.push({ kind: "code", lines: body, ...(lang ? { lang } : {}) });
      continue;
    }

    if (startsTable(lines, index)) {
      const align = tableCells(lines[index + 1]!).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":") ? ("center" as const) : cell.endsWith(":") ? ("right" as const) : cell.startsWith(":") ? ("left" as const) : null,
      );
      const body = [line];
      index += 2;
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim() !== "") body.push(lines[index++]!);
      blocks.push({ kind: "table", lines: body, align });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule", lines: [] });
      index++;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", lines: [heading[2]!], level: heading[1]!.length });
      index++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) body.push(lines[index++]!.replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", lines: body });
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index]!)) body.push(lines[index++]!.replace(/^[-*]\s+/, ""));
      blocks.push({ kind: "ul", lines: body });
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index]!)) body.push(lines[index++]!.replace(/^\d+[.)]\s+/, ""));
      blocks.push({ kind: "ol", lines: body });
      continue;
    }

    if (line.trim() === "") {
      index++;
      continue;
    }

    const body: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() !== "" &&
      !/^(```|>|[-*]\s|\d+[.)]\s|#{1,4}\s)/.test(lines[index]!) &&
      !(body.length > 0 && (startsTable(lines, index) || RULE.test(lines[index]!)))
    ) {
      body.push(lines[index++]!);
    }
    blocks.push({ kind: "p", lines: body });
  }

  return blocks;
}
