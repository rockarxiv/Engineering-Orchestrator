import { Fragment, createContext, memo, useContext, useEffect, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown, { type Components, type ExtraProps, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../cn.js";

/*
 * The one markdown renderer: react-markdown with remark-gfm (EO-707,
 * ARCHITECTURE.md §21.10), dressed in the reading surface's classes.
 *
 * It produces React elements and never touches dangerouslySetInnerHTML,
 * which is the whole security argument: agent output is model output,
 * and with no HTML string anywhere in the pipeline, injection isn't
 * something we sanitize against — it cannot occur. react-markdown shows
 * raw HTML in the source as the literal text it was, and nothing here
 * adds a plugin that would parse it. A parser bug renders text oddly; it
 * can never execute script.
 *
 * What it parses is CommonMark and GitHub's extensions to it — tables,
 * strikethrough, autolinked URLs, task lists — so lists, emphasis and
 * fences behave as they do everywhere else a person writes markdown.
 * Strikethrough takes two tildes only: one tilde is a home directory in
 * the prose EO's agents write far more often than it is a deletion.
 *
 * Three things are EO's own, in `remarkEo` below, and run on the parsed
 * tree before anything is drawn:
 *
 * - Only http(s) links become anchors, opened in a new window without
 *   handing over the opener. A link to any other scheme — `javascript:`,
 *   `mailto:`, a relative path — is shown as the source text it was
 *   typed as, and so is an image: nothing in a comment loads anything.
 * - Item keys in prose become references through
 *   `MarkdownItemReferenceProvider`. Never inside code, which has no text
 *   to find them in, and never inside an explicit link, which already
 *   says where it goes.
 *
 * A fenced block carries its language and a Copy button, and is lightly
 * highlighted by `highlight` below — a tokenizer that hands back text
 * runs with a class each, so it is as incapable of injecting markup as
 * the rest of this file.
 */

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
function isSafeHref(href: string | undefined): href is string {
  return href !== undefined && /^https?:\/\//i.test(href);
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

/**
 * The little of a markdown syntax tree `remarkEo` reads, declared here
 * rather than taken from `@types/mdast`, which would be a dependency of
 * its own for four fields.
 */
interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  url?: string;
  data?: object;
  position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined;
}

/**
 * The element a prose text node is drawn as when item references are on:
 * `ItemReferenceText`, which splits it against the catalog at draw time.
 * Marking the text, rather than splitting it here, keeps the parse free
 * of the catalog — a new catalog redraws the text, and parses nothing.
 */
const ITEM_TEXT = "eo-item-text";

/** The source a node was parsed from, exactly as typed. */
function sourceOf(node: MarkdownNode, source: string): string | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : source.slice(start, end);
}

/**
 * EO's pass over the parsed tree: unsafe links and every image become the
 * text they were typed as, and — with `itemReferences` — prose text is
 * marked for `ItemReferenceText`. A hand-written walk: one recursion over
 * children needs no tree-walking package.
 */
function remarkEo(options: { itemReferences: boolean }) {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value);
    const walk = (parent: MarkdownNode) => {
      const children = parent.children;
      if (!children) return;
      children.forEach((child, index) => {
        const literal =
          (child.type === "link" && !isSafeHref(child.url)) || child.type === "image" || child.type === "imageReference" ? sourceOf(child, source) : null;
        if (literal !== null) {
          // Plain text, and never marked: an explicit link names no item.
          children[index] = { type: "text", value: literal } as MarkdownNode;
        } else if (child.type === "text") {
          if (options.itemReferences) child.data = { ...child.data, hName: ITEM_TEXT };
        } else if (child.type !== "link" && child.type !== "linkReference") {
          walk(child);
        }
      });
    };
    walk(tree);
  };
}

/** Stable, so react-markdown is handed the same plugins on every draw. */
const REMARK_PLUGINS: Options["remarkPlugins"] = [[remarkGfm, { singleTilde: false }], [remarkEo, { itemReferences: false }]];
const REMARK_PLUGINS_WITH_ITEM_REFERENCES: Options["remarkPlugins"] = [[remarkGfm, { singleTilde: false }], [remarkEo, { itemReferences: true }]];

/** A prose text node, with the catalog's keys drawn as references. */
function ItemReferenceText({ children }: { children?: ReactNode }) {
  const referenceContext = useContext(MarkdownItemReferenceContext);
  if (!referenceContext || typeof children !== "string") return <>{children}</>;
  return (
    <>
      {splitItemReferenceText(children, referenceContext.matcher).map((part, index) =>
        part.kind === "item" ? <Fragment key={index}>{referenceContext.renderItemReference(part.value)}</Fragment> : part.value,
      )}
    </>
  );
}

type Drawn<Tag extends keyof React.JSX.IntrinsicElements> = ComponentPropsWithoutRef<Tag> & ExtraProps;

/**
 * A heading somebody typed into a comment is display type like any other
 * heading, and this is where the editorial voice shows up inside the
 * writing rather than around it.
 */
const HEADING = "font-display text-lg text-ink";

/** The text of a code element, the one trailing newline the parser adds taken off. */
function codeText(node: ExtraProps["node"]): { code: string; lang: string | undefined } {
  const code = node?.children[0];
  if (code?.type !== "element") return { code: "", lang: undefined };
  const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
  const classes = code.properties["className"];
  const language = Array.isArray(classes) ? classes.map(String).find((name) => name.startsWith("language-")) : undefined;
  return { code: text.replace(/\n$/, ""), lang: language?.slice("language-".length) };
}

/**
 * How each element is drawn. Every one takes what react-markdown hands it
 * but the `node`, which is the syntax tree and not a DOM attribute.
 */
const COMPONENTS = {
  a: ({ node: _node, href, children }: Drawn<"a">) =>
    // `remarkEo` has already turned an unsafe inline link into text; this
    // catches the rest — a reference-style link, a footnote's anchor.
    isSafeHref(href) ? (
      <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  code: ({ node: _node, className, ...props }: Drawn<"code">) => <code className={cn("rounded-sm bg-canvas-active px-1 py-px font-mono text-sm", className)} {...props} />,
  pre: ({ node }: Drawn<"pre">) => {
    const { code, lang } = codeText(node);
    return <CodeBlock code={code} lang={lang} />;
  },
  hr: () => <hr className="border-0 border-t border-line" />,
  h1: ({ node: _node, ...props }: Drawn<"h1">) => <h1 {...props} className={HEADING} />,
  h2: ({ node: _node, ...props }: Drawn<"h2">) => <h2 {...props} className={HEADING} />,
  h3: ({ node: _node, ...props }: Drawn<"h3">) => <h3 {...props} className={HEADING} />,
  h4: ({ node: _node, ...props }: Drawn<"h4">) => <h4 {...props} className={HEADING} />,
  h5: ({ node: _node, ...props }: Drawn<"h5">) => <h5 {...props} className={HEADING} />,
  h6: ({ node: _node, ...props }: Drawn<"h6">) => <h6 {...props} className={HEADING} />,
  blockquote: ({ node: _node, ...props }: Drawn<"blockquote">) => <blockquote {...props} className="border-l-2 border-line-strong pl-3 text-ink-muted" />,
  ul: ({ node: _node, className, ...props }: Drawn<"ul">) => <ul {...props} className={cn("list-disc pl-5", className)} />,
  ol: ({ node: _node, className, ...props }: Drawn<"ol">) => <ol {...props} className={cn("list-decimal pl-5", className)} />,
  table: ({ node: _node, ...props }: Drawn<"table">) => (
    <div className="max-w-full overflow-x-auto">
      <table {...props} className="w-full border-collapse text-[0.9em]" />
    </div>
  ),
  tbody: ({ node: _node, ...props }: Drawn<"tbody">) => <tbody {...props} className="[&>tr]:border-b [&>tr]:border-line" />,
  th: ({ node: _node, style, ...props }: Drawn<"th">) => (
    <th {...props} style={{ textAlign: "left", ...style }} className="border-b border-line-strong px-2 py-1.5 font-semibold text-ink" />
  ),
  td: ({ node: _node, style, ...props }: Drawn<"td">) => <td {...props} style={{ textAlign: "left", ...style }} className="px-2 py-1.5 align-top" />,
  // Not an HTML element: what `remarkEo` marks prose text as.
  [ITEM_TEXT]: ItemReferenceText,
} as Components;

/**
 * The parse, kept per source (EO-551): a chat redraws its rows while a
 * turn streams, and the words of a finished message do not change under
 * it. Memoised on the source alone — the plugins and components are
 * constants — so a new `className` or a new catalog parses nothing.
 */
const ParsedMarkdown = memo(function ParsedMarkdown({ source, itemReferences }: { source: string; itemReferences: boolean }) {
  return (
    <ReactMarkdown remarkPlugins={itemReferences ? REMARK_PLUGINS_WITH_ITEM_REFERENCES : REMARK_PLUGINS} components={COMPONENTS}>
      {source}
    </ReactMarkdown>
  );
});

export interface MarkdownProps {
  children: string;
  className?: string | undefined;
}

export function Markdown({ children, className }: MarkdownProps) {
  // Item references are found only under a provider; outside one, prose
  // text is left as the parser made it.
  const itemReferences = useContext(MarkdownItemReferenceContext) !== null;

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
      <ParsedMarkdown source={children} itemReferences={itemReferences} />
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
