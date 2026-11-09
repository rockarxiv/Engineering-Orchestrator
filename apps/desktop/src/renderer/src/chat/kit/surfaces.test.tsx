import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GroupLabel } from "./surfaces";

describe("GroupLabel", () => {
  // A heading a person reads is the section register, not the machine's mono capitals (ARCHITECTURE.md §22.2; EO-691).
  it("sets its heading in the body face, sentence case, 600 — not mono uppercase", () => {
    render(<GroupLabel trailing="2 running">Acceptance criteria</GroupLabel>);
    const heading = screen.getByText("Acceptance criteria").parentElement;
    expect(heading).toHaveClass("voice-section");
    expect(heading?.className).not.toMatch(/\b(font-mono|uppercase|voice-label)\b|tracking-/);
    expect(heading).toHaveTextContent("Acceptance criteria2 running");
  });
});
