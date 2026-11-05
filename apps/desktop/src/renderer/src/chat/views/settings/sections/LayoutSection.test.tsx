import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PRESET_ID, THEME_STORAGE_KEY, setThemeChoice } from "../../../theme";
import { LayoutSection } from "./LayoutSection";

/**
 * Settings → Colours (`?section=layout`). The window-wide half — the
 * theme painted over the frame — is `ChatLayout.test.tsx`'s; this is the
 * section.
 */

function renderLayout(at = "/settings?section=layout") {
  render(
    <MemoryRouter initialEntries={[at]}>
      <LayoutSection />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  act(() => {
    setThemeChoice({ kind: "preset", id: DEFAULT_PRESET_ID });
  });
});

describe("the section", () => {
  it("offers colour themes and nothing else: there is one layout, so there is no layout to choose (EO-529)", () => {
    renderLayout();
    expect(screen.queryByRole("radiogroup", { name: "Layout" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText(/Classic/)).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Colour themes" })).toBeInTheDocument();
  });
});

describe("the colours", () => {
  it("offers the presets as pressed-or-not swatches, Claude unless somebody chose otherwise", () => {
    renderLayout();
    const themes = screen.getByRole("group", { name: "Colour themes" });
    expect(within(themes).getByRole("button", { name: /Claude/ })).toHaveAttribute("aria-pressed", "true");
    // Nothing to reset while the default is in use.
    expect(screen.queryByRole("button", { name: "Reset to Claude" })).not.toBeInTheDocument();

    fireEvent.click(within(themes).getByRole("button", { name: /Tokyo Night/ }));

    expect(within(themes).getByRole("button", { name: /Tokyo Night/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(themes).getByRole("button", { name: /Claude/ })).toHaveAttribute("aria-pressed", "false");
    expect(JSON.parse(window.localStorage.getItem(THEME_STORAGE_KEY)!)).toEqual({ kind: "preset", id: "tokyo-night" });
  });

  it("makes a custom theme from the accent picker, and resets to Claude", async () => {
    renderLayout();

    fireEvent.input(screen.getByLabelText("Accent"), { target: { value: "#d946ef" } });
    const themes = screen.getByRole("group", { name: "Colour themes" });
    await waitFor(() => expect(within(themes).getByRole("button", { name: /Custom/ })).toHaveAttribute("aria-pressed", "true"));
    expect(JSON.parse(window.localStorage.getItem(THEME_STORAGE_KEY)!)).toMatchObject({ kind: "custom" });

    fireEvent.click(screen.getByRole("button", { name: "Reset to Claude" }));
    await waitFor(() => expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull());
    expect(within(themes).getByRole("button", { name: /Claude/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("warns when a picked accent could be read as a status", async () => {
    renderLayout();
    fireEvent.input(screen.getByLabelText("Accent"), { target: { value: "#22c55e" } });
    expect(await screen.findByRole("status")).toHaveTextContent(/close to the colour that means running/);
  });

  it("never warns about a preset's accent that came along with a picked background", async () => {
    renderLayout();
    fireEvent.input(screen.getByLabelText("Background"), { target: { value: "#1e3a5f" } });
    const themes = screen.getByRole("group", { name: "Colour themes" });
    await waitFor(() => expect(within(themes).getByRole("button", { name: /Custom/ })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps a custom theme a press away after trying a preset", async () => {
    renderLayout();
    fireEvent.input(screen.getByLabelText("Accent"), { target: { value: "#0ea5e9" } });
    const themes = screen.getByRole("group", { name: "Colour themes" });
    await waitFor(() => expect(within(themes).getByRole("button", { name: /Custom/ })).toHaveAttribute("aria-pressed", "true"));
    const custom = window.localStorage.getItem(THEME_STORAGE_KEY);

    fireEvent.click(within(themes).getByRole("button", { name: /Linear/ }));
    await waitFor(() => expect(within(themes).getByRole("button", { name: /Custom/ })).toHaveAttribute("aria-pressed", "false"));
    fireEvent.click(within(themes).getByRole("button", { name: /Custom/ }));
    await waitFor(() => expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(custom));
  });
});
