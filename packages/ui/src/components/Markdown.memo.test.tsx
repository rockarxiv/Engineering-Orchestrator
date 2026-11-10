import { render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown, MarkdownItemReferenceProvider, createItemReferenceMatcher } from "./Markdown.js";

// The parser, counted: react-markdown parses its source on every render of
// its component, so each call is one parse. The real one underneath, so
// what is drawn is unchanged.
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return { ...actual, default: vi.fn(actual.default) };
});

const parse = vi.mocked(ReactMarkdown);

describe("Markdown's parse (EO-551)", () => {
  beforeEach(() => {
    parse.mockClear();
  });

  it("does not parse again when it is drawn again with the same source", () => {
    const { rerender } = render(<Markdown>{"**Done.** The board has three steps."}</Markdown>);
    expect(parse).toHaveBeenCalledTimes(1);

    rerender(<Markdown>{"**Done.** The board has three steps."}</Markdown>);
    rerender(<Markdown className="text-sm">{"**Done.** The board has three steps."}</Markdown>);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Done.").tagName).toBe("STRONG");
  });

  it("parses again when the source changes", () => {
    const { rerender } = render(<Markdown>{"All do"}</Markdown>);
    rerender(<Markdown>{"All done — *three* steps."}</Markdown>);

    expect(parse).toHaveBeenCalledTimes(2);
    expect(parse.mock.lastCall?.[0].children).toBe("All done — *three* steps.");
    expect(screen.getByText("three").tagName).toBe("EM");
  });

  it("does not parse again when only the item catalog changes, and still draws the new catalog's references", () => {
    const renderItemReference = (itemKey: string) => <a href={`/items/${itemKey}`}>{itemKey}</a>;
    const { rerender } = render(
      <MarkdownItemReferenceProvider matcher={createItemReferenceMatcher(["EO-1"])} renderItemReference={renderItemReference}>
        <Markdown>{"EO-1 waits on EO-2."}</Markdown>
      </MarkdownItemReferenceProvider>,
    );
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["EO-1"]);

    rerender(
      <MarkdownItemReferenceProvider matcher={createItemReferenceMatcher(["EO-1", "EO-2"])} renderItemReference={renderItemReference}>
        <Markdown>{"EO-1 waits on EO-2."}</Markdown>
      </MarkdownItemReferenceProvider>,
    );

    expect(parse).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["EO-1", "EO-2"]);
  });
});
