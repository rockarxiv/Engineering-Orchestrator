import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field, Segmented, Switch, TextInput } from "./controls";

describe("the kit's controls", () => {
  it("names a field by its label alone, and describes it by its hint and error", () => {
    render(
      <Field label="Branch prefix" hint="Before every branch EO creates." error="Too long.">
        <TextInput />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Branch prefix" });
    expect(input).toHaveAccessibleDescription("Before every branch EO creates. Too long.");
  });

  it("toggles a switch from its words as well as its button", () => {
    function Held() {
      const [on, setOn] = useState(false);
      return <Switch checked={on} onChange={setOn} label="Pause on failure" />;
    }
    render(<Held />);
    fireEvent.click(screen.getByText("Pause on failure"));
    expect(screen.getByRole("switch", { name: "Pause on failure" })).toHaveAttribute("aria-checked", "true");
  });

  it("is one Tab stop as a radio group, chosen with the arrows", () => {
    function Held({ start }: { start: string }) {
      const [value, setValue] = useState(start);
      return (
        <Segmented
          label="Show"
          value={value}
          onChange={setValue}
          options={[
            { value: "board", label: "Board" },
            { value: "graph", label: "Graph" },
          ]}
        />
      );
    }
    const { unmount } = render(<Held start="board" />);
    expect(screen.getByRole("radio", { name: "Board" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Graph" })).toHaveAttribute("tabindex", "-1");
    screen.getByRole("radio", { name: "Board" }).focus();
    fireEvent.keyDown(screen.getByRole("radiogroup", { name: "Show" }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Graph" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Graph" })).toHaveFocus();
    unmount();

    // A value none of them holds still leaves the group reachable.
    render(<Held start="nowhere" />);
    expect(screen.getByRole("radio", { name: "Board" })).toHaveAttribute("tabindex", "0");
  });
});
