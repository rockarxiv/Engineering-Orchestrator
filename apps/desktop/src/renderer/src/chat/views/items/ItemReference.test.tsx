import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { createQueryClient } from "../../../query/client";
import { ItemRef, RefText } from "./ItemReference";

/** Item keys as links in the chat layout (the classic `ItemReference.test.tsx` is the model). */

function CurrentRoute() {
  return <div data-testid="current-route">{useLocation().pathname}</div>;
}

function mount(children: React.ReactNode, onPress = vi.fn()) {
  window.eo.ipc.invoke = vi.fn(async (channel: string) => {
    if (channel === "projects:list") return { ok: true, data: { projects: [{ id: "p1", name: "EO", repositoryIds: [] }], activeProjectId: "p1" } };
    if (channel === "items:list") return { ok: true, data: { items: [{ id: "t2", key: "Acme_7" }] } };
    if (channel === "items:listArchived") return { ok: true, data: { items: [{ id: "t9", key: "EO-9" }] } };
    return { ok: true, data: {} };
  }) as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ItemReferenceProvider>
            <button type="button" onClick={onPress}>
              {children}
            </button>
          </ItemReferenceProvider>
          <CurrentRoute />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return onPress;
}

describe("item references in the chat layout", () => {
  it("links live and archived keys as configured, and leaves an unknown key as text", async () => {
    mount(<RefText>{"Blocked by Acme_7 and EO-9, not GONE-1"}</RefText>);

    expect(await screen.findByRole("link", { name: "Acme_7" })).toHaveAttribute("href", "/items/t2");
    expect(await screen.findByRole("link", { name: "EO-9" })).toHaveAttribute("href", "/items/t9");
    expect(screen.queryByRole("link", { name: "GONE-1" })).not.toBeInTheDocument();
  });

  it("does not link a key quoted as code", async () => {
    mount(<RefText>{"Run `EO-9` again, then EO-9"}</RefText>);
    expect(await screen.findAllByRole("link", { name: "EO-9" })).toHaveLength(1);
  });

  it("navigates without pressing what it sits in", async () => {
    const onPress = mount(<RefText>{"See EO-9"}</RefText>);
    fireEvent.click(await screen.findByRole("link", { name: "EO-9" }));
    expect(screen.getByTestId("current-route")).toHaveTextContent("/items/t9");
    expect(onPress).not.toHaveBeenCalled();
  });

  it("links by a known id even where the catalog does not hold the key", async () => {
    mount(<ItemRef itemKey="WEB-7" itemId="elsewhere" />);
    expect(await screen.findByRole("link", { name: "WEB-7" })).toHaveAttribute("href", "/items/elsewhere");
  });
});
