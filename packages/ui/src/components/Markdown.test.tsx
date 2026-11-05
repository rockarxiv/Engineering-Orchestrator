import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createItemReferenceMatcher, highlight, Markdown, MarkdownItemReferenceProvider, splitItemReferenceText, type ItemReferenceTextPart } from "./Markdown.js";

const knownItems = new Map([
  ["EO-1", "/items/one"],
  ["APP2-42", "/items/forty-two"],
  ["OPS-TEAM-2", "/items/ops-team-two"],
]);

function renderWithItemReferences(source: string) {
  return render(
    <MarkdownItemReferenceProvider
      matcher={createItemReferenceMatcher(knownItems.keys())}
      renderItemReference={(itemKey) => {
        const href = knownItems.get(itemKey);
        return href ? <a href={href}>{itemKey}</a> : itemKey;
      }}
    >
      <Markdown>{source}</Markdown>
    </MarkdownItemReferenceProvider>,
  );
}

describe("Markdown safety", () => {
  it("renders raw HTML as text, never as markup — agent output is model output", () => {
    const { container } = render(<Markdown>{`<img src=x onerror="alert(1)"> and <b>bold?</b>`}</Markdown>);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=/)).toBeInTheDocument(); // shown literally
  });

  it("never emits a script element", () => {
    const { container } = render(<Markdown>{`<script>alert(1)</script>`}</Markdown>);
    expect(container.querySelector("script")).toBeNull();
  });

  it("refuses a javascript: link, rendering it as plain text", () => {
    render(<Markdown>{`[click me](javascript:alert(1))`}</Markdown>);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/click me/)).toBeInTheDocument();
  });

  it("links http(s) targets, opening them without handing over the opener", () => {
    render(<Markdown>{`see [the docs](https://example.com/x)`}</Markdown>);

    const link = screen.getByRole("link", { name: "the docs" });
    expect(link).toHaveAttribute("href", "https://example.com/x");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});

describe("Markdown rendering", () => {
  it("renders fenced code verbatim, including characters that look like markup", () => {
    const { container } = render(<Markdown>{"```ts\nconst a = b < c && d > e;\n```"}</Markdown>);
    // Highlighting splits it into runs; read together they are the code exactly.
    expect(container.querySelector("code")?.textContent).toBe("const a = b < c && d > e;");
  });

  it("renders bullet and numbered lists", () => {
    render(<Markdown>{"- one\n- two\n\n1. first\n2. second"}</Markdown>);

    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
  });

  it("renders inline emphasis and code", () => {
    const { container } = render(<Markdown>{"**bold** and *italic* and `code`"}</Markdown>);

    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("em")).toHaveTextContent("italic");
    expect(container.querySelector("code")).toHaveTextContent("code");
  });

  it("renders headings and blockquotes", () => {
    render(<Markdown>{"## A heading\n\n> a quotation"}</Markdown>);

    expect(screen.getByRole("heading", { name: "A heading" })).toBeInTheDocument();
    expect(screen.getByText("a quotation")).toBeInTheDocument();
  });

  /**
   * A long fence is closed by a long fence (EO-311).
   *
   * EO fences an output that is not prose with one backtick more than the
   * longest run inside it, precisely so the fences in a diff of a
   * documentation file cannot end it. This is that body, as
   * `workspaceKinds.test.ts` proves the workspace posts it.
   *
   * It survived the older parser by luck rather than by rule — every line
   * of a unified diff carries a `-`, `+`, `@` or space in front of it, so
   * none of its fences began a line. The case below is the one that did
   * not survive, and the two are kept together because this is the body
   * the product actually posts and a reader should see it pass.
   */
  it("closes a four-backtick block only on four backticks", () => {
    const { container } = render(
      <Markdown>{"````diff\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-```sh\n+```bash\n````"}</Markdown>,
    );

    const code = container.querySelectorAll("pre");
    expect(code).toHaveLength(1);
    // The whole diff, including the lines that look like fences.
    expect(code[0]).toHaveTextContent("-```sh");
    expect(code[0]).toHaveTextContent("+```bash");
    // And nothing escaped into prose beside it.
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  /**
   * The failure the rule above exists for, with nothing in front of the
   * inner fence to hide it: a report that quotes a fenced example, which
   * is what an agent drafting documentation produces and what a person
   * may type into the output editor. The older parser closed on the
   * inner ``` and rendered the rest as prose.
   */
  it("keeps a block open through a shorter fence that begins a line", () => {
    const { container } = render(<Markdown>{"````md\nRun it:\n\n```sh\npnpm dev\n```\n````"}</Markdown>);

    const code = container.querySelectorAll("pre");
    expect(code).toHaveLength(1);
    expect(code[0]).toHaveTextContent("pnpm dev");
    // Nothing spilled out of the block and became prose beside it.
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("treats a nested fence with a language as content, not as the closing one", () => {
    const { container } = render(<Markdown>{"```\n```ts\nconst a = 1;\n```"}</Markdown>);

    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelector("pre")).toHaveTextContent("const a = 1;");
  });

  it("keeps an unterminated code fence readable rather than swallowing the rest", () => {
    render(<Markdown>{"```\nstill code"}</Markdown>);
    expect(screen.getByText("still code")).toBeInTheDocument();
  });

  it("renders empty input without throwing", () => {
    const { container } = render(<Markdown>{""}</Markdown>);
    expect(container.firstChild).toBeTruthy();
  });
});

describe("Markdown item references", () => {
  it("links multiple known references independently when adjacent to punctuation", () => {
    renderWithItemReferences("See EO-1, then (APP2-42). EO-1's follow-up is ready.");

    expect(screen.getAllByRole("link", { name: "EO-1" })).toHaveLength(2);
    expect(screen.getByRole("link", { name: "APP2-42" })).toHaveAttribute("href", "/items/forty-two");
  });

  it("links an exact configured key whose prefix contains a hyphen", () => {
    renderWithItemReferences("Review OPS-TEAM-2; OLD-OPS-TEAM-2 was deleted.");

    expect(screen.getByRole("link", { name: "OPS-TEAM-2" })).toHaveAttribute("href", "/items/ops-team-two");
    expect(screen.getAllByRole("link", { name: "OPS-TEAM-2" })).toHaveLength(1);
  });

  it("leaves unknown item-like text as plain text", () => {
    renderWithItemReferences("EO-999 was deleted; OTHER-7 never existed.");

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText((_, element) => element?.tagName === "P" && element.textContent === "EO-999 was deleted; OTHER-7 never existed.")).toBeInTheDocument();
  });

  it("keeps explicit Markdown links at their authored destinations", () => {
    renderWithItemReferences("[EO-1](https://jira.example/browse/EO-1) and APP2-42");

    expect(screen.getByRole("link", { name: "EO-1" })).toHaveAttribute("href", "https://jira.example/browse/EO-1");
    expect(screen.getByRole("link", { name: "APP2-42" })).toHaveAttribute("href", "/items/forty-two");
  });

  it("does not resolve references in inline or fenced code", () => {
    const { container } = renderWithItemReferences("`EO-1`\n\n```text\nAPP2-42\n```");

    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelectorAll("code")).toHaveLength(2);
  });

  it("resolves references in emphasized prose", () => {
    renderWithItemReferences("**EO-1** and *APP2-42*");

    expect(screen.getByRole("link", { name: "EO-1" }).closest("strong")).not.toBeNull();
    expect(screen.getByRole("link", { name: "APP2-42" }).closest("em")).not.toBeNull();
  });

  it("still refuses unsafe explicit links containing item text", () => {
    renderWithItemReferences("[EO-1](javascript:alert(1))");

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/\[EO-1\]\(javascript:/)).toBeInTheDocument();
  });
});

describe("splitItemReferenceText with a matcher built once per catalog (EO-561)", () => {
  const text = (value: string): ItemReferenceTextPart => ({ kind: "text", value });
  const item = (value: string): ItemReferenceTextPart => ({ kind: "item", value });

  it("prefers the longer of two overlapping keys, and still finds the shorter on its own", () => {
    const matcher = createItemReferenceMatcher(["EO-1", "EO-12"]);

    expect(splitItemReferenceText("EO-12 then EO-1.", matcher)).toEqual([item("EO-12"), text(" then "), item("EO-1"), text(".")]);
    // The order the catalog lists them in makes no difference.
    expect(splitItemReferenceText("EO-12 then EO-1.", createItemReferenceMatcher(["EO-12", "EO-1"]))).toEqual(splitItemReferenceText("EO-12 then EO-1.", matcher));
  });

  it("does not take a shorter key out of a longer one the catalog does not hold", () => {
    const matcher = createItemReferenceMatcher(["EO-1"]);

    expect(splitItemReferenceText("EO-12 and EO-123 are not EO-1", matcher)).toEqual([text("EO-12 and EO-123 are not "), item("EO-1")]);
  });

  it("falls back to a shorter key where the longer one would continue a word", () => {
    const matcher = createItemReferenceMatcher(["EO-1", "EO-12"]);

    // EO-12 is followed by a letter, so it is not a key here; EO-1 is
    // followed by "2", which continues it, so neither is.
    expect(splitItemReferenceText("EO-12a", matcher)).toEqual([text("EO-12a")]);
    expect(splitItemReferenceText("EO-1, EO-12x", matcher)).toEqual([item("EO-1"), text(", EO-12x")]);
  });

  it("leaves a key inside a word as text", () => {
    const matcher = createItemReferenceMatcher(["EO-1", "OPS-TEAM-2"]);

    for (const inside of ["XEO-1", "EO-1b", "EO-1_", "_EO-1", "EO-1-2", "OLD-OPS-TEAM-2", "ÉEO-1", "EO-1é", "7EO-1", "EO-1EO-1"]) {
      expect(splitItemReferenceText(inside, matcher)).toEqual([text(inside)]);
    }
    expect(splitItemReferenceText("(EO-1)/EO-1's [OPS-TEAM-2]", matcher)).toEqual([
      text("("),
      item("EO-1"),
      text(")/"),
      item("EO-1"),
      text("'s ["),
      item("OPS-TEAM-2"),
      text("]"),
    ]);
  });

  it("treats a key's characters literally, however they read as a pattern", () => {
    const matcher = createItemReferenceMatcher(["A.B-1", "C+D-2", "(X)-3"]);

    expect(splitItemReferenceText("A.B-1 AxB-1 C+D-2 CCD-2 (X)-3", matcher)).toEqual([
      item("A.B-1"),
      text(" AxB-1 "),
      item("C+D-2"),
      text(" CCD-2 "),
      item("(X)-3"),
    ]);
  });

  it("holds no position between texts, so one matcher serves every segment", () => {
    const matcher = createItemReferenceMatcher(["EO-1"]);

    expect(splitItemReferenceText("a long line before EO-1", matcher)).toEqual([text("a long line before "), item("EO-1")]);
    expect(splitItemReferenceText("EO-1", matcher)).toEqual([item("EO-1")]);
    expect(splitItemReferenceText("EO-1", matcher)).toEqual([item("EO-1")]);
  });

  it("returns nothing for no text, and the text for an empty catalog", () => {
    expect(splitItemReferenceText("", createItemReferenceMatcher(["EO-1"]))).toEqual([]);
    expect(splitItemReferenceText("EO-1", createItemReferenceMatcher(["", ""]))).toEqual([text("EO-1")]);
  });
});

describe("MarkdownItemReferenceProvider", () => {
  it("re-renders no Markdown when it is drawn again with the same matcher and renderer", () => {
    const matcher = createItemReferenceMatcher(["EO-1"]);
    let rendered = 0;
    const renderItemReference = (itemKey: string) => {
      rendered += 1;
      return <a href="/items/one">{itemKey}</a>;
    };
    // The same element each time, as a host's children are: only a
    // changed context can redraw it.
    const child = <Markdown>{"See EO-1."}</Markdown>;
    const Host = ({ tick }: { tick: number }) => (
      <div data-tick={tick}>
        <MarkdownItemReferenceProvider matcher={matcher} renderItemReference={renderItemReference}>
          {child}
        </MarkdownItemReferenceProvider>
      </div>
    );

    const { rerender } = render(<Host tick={1} />);
    expect(rendered).toBe(1);
    rerender(<Host tick={2} />);
    expect(rendered).toBe(1);

    // A new catalog is a new matcher, and that does reach it.
    const Changed = () => (
      <MarkdownItemReferenceProvider matcher={createItemReferenceMatcher(["EO-1"])} renderItemReference={renderItemReference}>
        {child}
      </MarkdownItemReferenceProvider>
    );
    rerender(<div data-tick={3}><Changed /></div>);
    expect(rendered).toBeGreaterThan(1);
  });
});

describe("Markdown tables, rules and code blocks", () => {
  it("renders a table with its header, rows and alignment", () => {
    render(<Markdown>{"Before\n| Step | Owner | Count |\n| --- | :---: | ---: |\n| Draft | **Anna** | 3 |\n| Ship | `bot` | 12 |\nAfter"}</Markdown>);
    const table = screen.getByRole("table");
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Step", "Owner", "Count"]);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("Anna").tagName).toBe("STRONG");
    expect(screen.getAllByRole("cell")[2]).toHaveStyle({ textAlign: "right" });
    expect(table).toBeInTheDocument();
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
  });

  it("does not make a table of a line with a pipe over a bare rule, and draws an underlined line as text over a rule", () => {
    const { container } = render(<Markdown>{"Total |\n---\n\nHeading\n---"}</Markdown>);
    expect(screen.queryByRole("table")).toBeNull();
    expect(container.querySelectorAll("hr")).toHaveLength(2);
    expect(screen.getByText("Heading")).toBeInTheDocument();
  });

  it("keeps a line with a pipe and no separator under it as prose", () => {
    render(<Markdown>{"a | b\nnot a table"}</Markdown>);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("draws a rule and strikethrough", () => {
    const { container } = render(<Markdown>{"one\n\n---\n\n~~gone~~ two"}</Markdown>);
    expect(container.querySelector("hr")).not.toBeNull();
    expect(screen.getByText("gone").tagName).toBe("DEL");
  });

  it("names a block's language and copies its code exactly", async () => {
    const written: string[] = [];
    Object.assign(navigator, { clipboard: { writeText: async (text: string) => void written.push(text) } });
    render(<Markdown>{"```python\n# note\nprint('hi')\n```"}</Markdown>);
    expect(screen.getByText("python")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(written).toEqual(["# note\nprint('hi')"]);
  });
});

describe("highlighting", () => {
  it("marks comments, strings, keywords and numbers, and loses nothing", () => {
    const code = 'const x = "a // b"; // real\nreturn 42;';
    const runs = highlight(code, "ts");
    expect(runs.map((run) => run.text).join("")).toBe(code);
    expect(runs.filter((run) => run.kind === "string").map((run) => run.text)).toEqual(['"a // b"']);
    expect(runs.filter((run) => run.kind === "comment").map((run) => run.text)).toEqual(["// real"]);
    expect(runs.filter((run) => run.kind === "keyword").map((run) => run.text)).toEqual(["const", "return"]);
    expect(runs.filter((run) => run.kind === "number").map((run) => run.text)).toEqual(["42"]);
  });

  it("uses # comments for shell and python, and leaves prose, diffs and unlabelled blocks alone", () => {
    expect(highlight("ls # list", "bash").find((run) => run.kind === "comment")?.text).toBe("# list");
    expect(highlight("+ const a", "diff")).toEqual([{ kind: "plain", text: "+ const a" }]);
    expect(highlight("const a", undefined)).toEqual([{ kind: "plain", text: "const a" }]);
  });
});
