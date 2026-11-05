import { Fragment, createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../cn.js";
import { tableCells, toBlocks } from "./markdownBlocks.js";

export { tableCells };

/*
 * A deliberately small markdown renderer.
 *
 * It produces React elements and never touches dangerouslySetInnerHTML,
 * which is the whole security argument: agent output is model output,
 * and with no HTML string anywhere in the pipeline, injection isn't
 * something we sanitize against — it cannot occur. A parser bug here
 * renders text oddly; it can never execute script. That property is
 * worth more than full CommonMark coverage for a comment thread.
 *
 * Supported, because it is what agents and humans actually write in
 * comments: fenced code, inline code, bold, italic, strikethrough, links,
 * bullet and numbered lists, blockquotes, headings, tables, rules and
 * paragraphs. Anything else is shown as the literal text it was — never
 * silently dropped.
 *
 * A fenced block carries its language and a Copy button, and is lightly
 * highlighted by `highlight` below — a tokenizer that hands back text
 * runs with a class each, so it is as incapable of injecting markup as
 * the rest of this file.
 */

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)\s]+\))/g;

export type MarkdownItemReferenceRenderer = (itemKey: string) => ReactNode;

interface MarkdownItemReferenceContextValue {
  matcher: ItemReferenceMatcher;
  renderItemReference: MarkdownItemReferenceRenderer;
}

const MarkdownItemReferenceContext = createContext<MarkdownItemReferenceContextValue | null>(null);

export interface MarkdownItemReferenceProviderProps {
  children: ReactNode;
  /**
   * The host application's live and archived keys, as one matcher
   * (`createItemReferenceMatcher`). Built once per catalog by the host and
   * handed down with the same identity while the catalog is unchanged:
   * a new one re-renders every `Markdown` beneath.
   */
  matcher: ItemReferenceMatcher;
  renderItemReference: MarkdownItemReferenceRenderer;
}

/**
 * Installs the host application's item resolver without coupling this
 * browser-safe package to its router or data layer.
 *
 * The value keeps its identity while the matcher and the renderer do
 * (EO-561), so a host that re-renders for its own reasons — a refetch
 * that changed nothing — re-renders no `Markdown` under it.
 */
export function MarkdownItemReferenceProvider({ children, matcher, renderItemReference }: MarkdownItemReferenceProviderProps) {
  const value = useMemo(() => ({ matcher, renderItemReference }), [matcher, renderItemReference]);
  return <MarkdownItemReferenceContext.Provider value={value}>{children}</MarkdownItemReferenceContext.Provider>;
}

/** Only http(s) links become anchors — a `javascript:` URL renders as plain text. */
function safeHref(href: string): string | null {
  return /^https?:\/\//i.test(href) ? href : null;
}

export type ItemReferenceTextPart =
  | { kind: "text"; value: string }
  | { kind: "item"; value: string };

/**
 * A catalog's keys, compiled once (EO-561): what `splitItemReferenceText`
 * finds keys with. Build it when the catalog changes, not per text.
 */
export interface ItemReferenceMatcher {
  /** Every key the matcher finds, exactly as given. */
  readonly keys: ReadonlySet<string>;
  /** One alternation of every key, longest first; null when there are none. */
  readonly pattern: RegExp | null;
}

/** What may continue an item-like token: a key next to one of these is inside a word. */
const TOKEN_CHARACTER = "[\\p{L}\\p{N}_-]";

/** Escapes what a `u`-mode pattern treats as syntax — and only that, since `\-` is an error there. */
function escapeKey(key: string): string {
  return key.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/**
 * Compiles a catalog's keys into one pattern: an alternation sorted longest
 * first, between lookarounds that refuse a key continuing a word on either
 * side. Where a longer key fails its boundary the alternation falls back to
 * a shorter one at the same place, exactly as trying each key in turn did.
 */
export function createItemReferenceMatcher(itemKeys: Iterable<string>): ItemReferenceMatcher {
  const keys = new Set([...itemKeys].filter(Boolean));
  if (keys.size === 0) return { keys, pattern: null };
  const alternation = [...keys].sort((left, right) => right.length - left.length).map(escapeKey).join("|");
  return { keys, pattern: new RegExp(`(?<!${TOKEN_CHARACTER})(?:${alternation})(?!${TOKEN_CHARACTER})`, "gu") };
}

/**
 * Finds only exact catalog keys, preferring the longest when configured keys
 * overlap. Token boundaries keep a shorter key from linking inside another
 * item-like value such as `OPS-TEAM-2`.
 */
export function splitItemReferenceText(text: string, matcher: ItemReferenceMatcher): ItemReferenceTextPart[] {
  if (text === "") return [];
  if (matcher.pattern === null) return [{ kind: "text", value: text }];

  const parts: ItemReferenceTextPart[] = [];
  let textStart = 0;
  // `matchAll` scans a copy of the pattern, so one shared matcher holds no
  // position between texts.
  for (const match of text.matchAll(matcher.pattern)) {
    const index = match.index ?? 0;
    if (textStart < index) parts.push({ kind: "text", value: text.slice(textStart, index) });
    parts.push({ kind: "item", value: match[0] });
    textStart = index + match[0].length;
  }

  if (textStart < text.length) parts.push({ kind: "text", value: text.slice(textStart) });
  return parts;
}

function renderItemReferences(text: string, keyPrefix: string, referenceContext: MarkdownItemReferenceContextValue | null): ReactNode[] {
  if (!referenceContext) return [text];

  return splitItemReferenceText(text, referenceContext.matcher).map((part, index) => {
    const key = `${keyPrefix}-ticket-${index}`;
    return part.kind === "item" ? (
      <Fragment key={key}>{referenceContext.renderItemReference(part.value)}</Fragment>
    ) : (
      part.value
    );
  });
}

function renderInline(text: string, keyPrefix: string, referenceContext: MarkdownItemReferenceContextValue | null): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((piece, index) => {
    const key = `${keyPrefix}-${index}`;

    if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
      return (
        <code key={key} className="rounded-sm bg-canvas-active px-1 py-px font-mono text-sm">
          {piece.slice(1, -1)}
        </code>
      );
    }
    if (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) {
      return <strong key={key}>{renderItemReferences(piece.slice(2, -2), key, referenceContext)}</strong>;
    }
    if (piece.startsWith("~~") && piece.endsWith("~~") && piece.length > 4) {
      return <del key={key}>{renderItemReferences(piece.slice(2, -2), key, referenceContext)}</del>;
    }
    if ((piece.startsWith("*") && piece.endsWith("*") && piece.length > 2) || (piece.startsWith("_") && piece.endsWith("_") && piece.length > 2)) {
      return <em key={key}>{renderItemReferences(piece.slice(1, -1), key, referenceContext)}</em>;
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(piece);
    if (link) {
      const href = safeHref(link[2]!);
      // An unsafe scheme falls through to its literal text rather than
      // becoming a link that does something unexpected.
      return href ? (
        <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">
          {link[1]}
        </a>
      ) : (
        <span key={key}>{piece}</span>
      );
    }

    return <Fragment key={key}>{renderItemReferences(piece, key, referenceContext)}</Fragment>;
  });
}

export interface MarkdownProps {
  children: string;
  className?: string | undefined;
}

export function Markdown({ children, className }: MarkdownProps) {
  // Parsed once per source, not once per render (EO-551): a chat redraws
  // its rows while a turn streams, and the words of a finished message do
  // not change under it.
  const blocks = useMemo(() => toBlocks(children), [children]);
  const itemReferenceContext = useContext(MarkdownItemReferenceContext);

  return (
    /*
     * The reading surface, and the only one in the app (ARCHITECTURE.md,
     * "Type"). Everything a person or an agent *wrote* — an item
     * body, a comment, a discussion turn, an escalation reason — comes
     * through here, so raising it to `--text-read` with real leading and a
     * real measure sets every prose surface at once, and nothing else.
     *
     * 16px against the app's 14px chrome is the contrast that lets you
     * tell prose from furniture without reading a word. The 65ch cap is
     * what stops a comment running the full width of a 1600px window,
     * where the eye loses the line it is on.
     */
    <div className={cn("flex max-w-[65ch] flex-col gap-3 text-read leading-[1.6]", className)}>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case "code":
            return <CodeBlock key={key} code={block.lines.join("\n")} lang={block.lang} />;
          case "rule":
            return <hr key={key} className="border-0 border-t border-line" />;
          case "table": {
            const [head, ...rows] = block.lines;
            const align = block.align ?? [];
            return (
              <div key={key} className="max-w-full overflow-x-auto">
                <table className="w-full border-collapse text-[0.9em]">
                  <thead>
                    <tr>
                      {tableCells(head ?? "").map((cell, cellIndex) => (
                        <th key={cellIndex} style={{ textAlign: align[cellIndex] ?? "left" }} className="border-b border-line-strong px-2 py-1.5 font-semibold text-ink">
                          {renderInline(cell, `${key}-h${cellIndex}`, itemReferenceContext)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-b border-line">
                        {tableCells(row).map((cell, cellIndex) => (
                          <td key={cellIndex} style={{ textAlign: align[cellIndex] ?? "left" }} className="px-2 py-1.5 align-top">
                            {renderInline(cell, `${key}-${rowIndex}-${cellIndex}`, itemReferenceContext)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          case "heading": {
            const Tag = (["h1", "h2", "h3", "h4"] as const)[(block.level ?? 1) - 1] ?? "h4";
            return (
              // A heading somebody typed into a comment is display type
              // like any other heading, and this is where the editorial
              // voice shows up inside the writing rather than around it.
              <Tag key={key} className="font-display text-lg text-ink">
                {renderInline(block.lines[0] ?? "", key, itemReferenceContext)}
              </Tag>
            );
          }
          case "quote":
            return (
              <blockquote key={key} className="border-l-2 border-line-strong pl-3 text-ink-muted">
                {renderInline(block.lines.join(" "), key, itemReferenceContext)}
              </blockquote>
            );
          case "ul":
            return (
              <ul key={key} className="list-disc pl-5">
                {block.lines.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`, itemReferenceContext)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key} className="list-decimal pl-5">
                {block.lines.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`, itemReferenceContext)}</li>
                ))}
              </ol>
            );
          default:
            return <p key={key}>{renderInline(block.lines.join(" "), key, itemReferenceContext)}</p>;
        }
      })}
    </div>
  );
}

/**
 * A fenced block: what language it says it is, a Copy button, and the code
 * lightly highlighted. The copy is the code exactly as written.
 */
function CodeBlock({ code, lang }: { code: string; lang: string | undefined }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="group/code relative overflow-hidden rounded-md border border-line bg-canvas-subtle">
      <div className="flex h-7 items-center justify-between border-b border-line px-2">
        <span className="font-mono text-[11px] text-ink-subtle">{lang ?? ""}</span>
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => undefined);
          }}
          className="grid h-5 w-5 place-items-center rounded text-ink-subtle hover:bg-canvas-hover hover:text-ink"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre className="overflow-x-auto p-2">
        <code className="font-mono text-sm">
          {highlight(code, lang).map((run, index) =>
            run.kind === "plain" ? <Fragment key={index}>{run.text}</Fragment> : <span key={index} className={TOKEN_CLASS[run.kind]}>{run.text}</span>,
          )}
        </code>
      </pre>
    </div>
  );
}

type TokenKind = "plain" | "comment" | "string" | "keyword" | "number";

/**
 * Highlighting on the ink ladder only (ARCHITECTURE.md, "Colour"): the
 * status colours mean states and the accent means "you can act", so a
 * code block that borrowed them would say things it does not mean.
 * Weight and the three inks are enough to tell a keyword from a string
 * from a comment at a glance.
 */
const TOKEN_CLASS: Record<Exclude<TokenKind, "plain">, string> = {
  comment: "text-ink-subtle",
  string: "text-ink-muted",
  keyword: "font-semibold text-ink",
  number: "text-ink-muted",
};

const KEYWORDS = new Set(
  (
    "abstract as async await break case catch class const continue def default del do elif else enum export extends false final finally fn for from func " +
    "function go if impl import in interface is let match mod module mut new nil none null of package pass private protected pub public raise return " +
    "select self static struct super switch this throw throws trait true try type typeof undefined use val var void where while with yield"
  ).split(" "),
);

/** Languages whose line comments start with `#` rather than `//`. */
const HASH_COMMENTS = new Set(["py", "python", "sh", "bash", "zsh", "fish", "shell", "console", "rb", "ruby", "yaml", "yml", "toml", "r", "perl", "pl", "dockerfile", "make", "makefile"]);
/** Languages a tokenizer for code would only mangle. */
const NOT_CODE = new Set(["text", "txt", "plain", "plaintext", "diff", "patch", "md", "markdown", "log", "output", "csv"]);

/**
 * Splits code into runs a reader's eye can sort: comments, strings,
 * keywords, numbers, and everything else as it was. Deliberately small —
 * a handful of rules that are right for most languages people paste, and
 * nothing at all for prose, diffs and logs. Joined back up, the runs are
 * the input exactly.
 */
export function highlight(code: string, lang: string | undefined): { kind: TokenKind; text: string }[] {
  const language = (lang ?? "").toLowerCase();
  if (language === "" || NOT_CODE.has(language) || code.length > 50_000) return [{ kind: "plain", text: code }];
  const hash = HASH_COMMENTS.has(language);
  const pattern = hash
    ? /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(\d[\d_.]*(?:e[+-]?\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d[\d_.]*(?:e[+-]?\d+)?)\b|\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  const runs: { kind: TokenKind; text: string }[] = [];
  let last = 0;
  const push = (kind: TokenKind, text: string) => {
    if (text === "") return;
    const previous = runs.at(-1);
    if (previous && previous.kind === kind) previous.text += text;
    else runs.push({ kind, text });
  };
  for (const match of code.matchAll(pattern)) {
    const start = match.index ?? 0;
    push("plain", code.slice(last, start));
    const [whole, comment, string, number, word] = match;
    if (comment !== undefined) push("comment", whole);
    else if (string !== undefined) push("string", whole);
    else if (number !== undefined) push("number", whole);
    else if (word !== undefined && KEYWORDS.has(word)) push("keyword", whole);
    else push("plain", whole);
    last = start + whole.length;
  }
  push("plain", code.slice(last));
  return runs;
}
