import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown.js";
import { toBlocks } from "./markdownBlocks.js";

// The parser, counted: the real one underneath, so what is drawn is unchanged.
vi.mock("./markdownBlocks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./markdownBlocks.js")>();
  return { ...actual, toBlocks: vi.fn(actual.toBlocks) };
});

const parse = vi.mocked(toBlocks);

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
    expect(parse).toHaveBeenLastCalledWith("All done — *three* steps.");
    expect(screen.getByText("three").tagName).toBe("EM");
  });
});
