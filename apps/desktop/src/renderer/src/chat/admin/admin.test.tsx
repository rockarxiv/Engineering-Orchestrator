import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AdminAuthorityProvider, useItemAuthority } from "../../shared/admin/authority";
import { setBridge } from "../../ipc/bridge";
import { createQueryClient } from "../../query/client";
import { ActAsAdmin } from "./ActAsAdmin";
import { ReadOnlyFence } from "./ReadOnlyFence";

/**
 * The chat layout's admin line and fence, held to the classic ones'
 * cases (`admin/authority.test.tsx`): a safety catch drawn only where
 * somebody is looking into another team's work, per item, and never on a
 * desktop.
 */

/** A browser served by an organisation, answering `people:me` as the person named. */
function whoAmI(person: { id: string; name: string; isAdmin: boolean }, organisation: boolean) {
  const answer = {
    ok: true as const,
    data: {
      person: { id: person.id, name: person.name, email: null, isAdmin: person.isAdmin, invitedAt: null, acceptedAt: null, credentialKind: null },
      admin: person.isAdmin,
      organisation,
    },
  };
  setBridge({
    invoke: (async (channel: string) => (channel === "people:me" ? answer : { ok: true, data: {} })) as never,
    machineAvailable: false,
    subscribe: () => () => {},
    subscribeRefetch: () => () => {},
  });
}

function onADesktop() {
  setBridge({
    invoke: (async () => ({ ok: true, data: {} })) as never,
    machineAvailable: true,
    subscribe: () => () => {},
    subscribeRefetch: () => () => {},
  });
}

afterEach(() => setBridge(undefined));

function mount(children: ReactNode) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AdminAuthorityProvider>{children}</AdminAuthorityProvider>
    </QueryClientProvider>,
  );
}

/** The fenced region as an item view draws it: a decision button and a field, neither told about the catch. */
function Fenced({ itemId }: { itemId: string }) {
  const { readOnly } = useItemAuthority(itemId);
  return (
    <ReadOnlyFence readOnly={readOnly}>
      <button type="button">Approve</button>
      <input aria-label="Title" />
      <a href="#elsewhere">Read the run</a>
    </ReadOnlyFence>
  );
}

describe("the chat layout's admin line", () => {
  it("draws nothing at all on a desktop", async () => {
    onADesktop();
    mount(
      <>
        <ActAsAdmin itemId="t1" />
        <Fenced itemId="t1" />
      </>,
    );

    expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Act as admin" })).not.toBeInTheDocument();
  });

  it("draws nothing for a colleague reading their own projects", async () => {
    whoAmI({ id: "p-anna", name: "Anna Ruiz", isAdmin: false }, true);
    mount(
      <>
        <ActAsAdmin itemId="t1" />
        <Fenced itemId="t1" />
      </>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Act as admin" })).not.toBeInTheDocument();
  });

  it("fences the region, and says why, for an admin looking into somebody else's work", async () => {
    whoAmI({ id: "p-dana", name: "Dana Okoro", isAdmin: true }, true);
    mount(
      <>
        <ActAsAdmin itemId="t1" />
        <Fenced itemId="t1" />
      </>,
    );

    expect(await screen.findByRole("status")).toHaveTextContent("Nothing here will move until you say so.");
    // Every control inside the fence, without any of them being told.
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
    // A link still reads.
    expect(screen.getByRole("link", { name: "Read the run" })).toBeInTheDocument();
  });

  it("opens the fence once the admin says so, and keeps saying that they did", async () => {
    whoAmI({ id: "p-dana", name: "Dana Okoro", isAdmin: true }, true);
    mount(
      <>
        <ActAsAdmin itemId="t1" />
        <Fenced itemId="t1" />
      </>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Act as admin" }));

    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("recorded under your name");
    expect(screen.queryByRole("button", { name: "Act as admin" })).not.toBeInTheDocument();
  });

  it("is per item, so one decision does not unlock the board", async () => {
    whoAmI({ id: "p-dana", name: "Dana Okoro", isAdmin: true }, true);
    mount(
      <>
        <ActAsAdmin itemId="t1" />
        <Fenced itemId="t1" />
        <Fenced itemId="t2" />
      </>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Act as admin" }));

    const [first, second] = screen.getAllByRole("button", { name: "Approve" });
    expect(first).toBeEnabled();
    expect(second).toBeDisabled();
  });
});

describe("the chat layout's read-only fence", () => {
  it("takes no box of its own, so it changes what a control does and not where it sits", () => {
    render(
      <ReadOnlyFence readOnly={false} className="extra">
        <button type="button">Archive</button>
      </ReadOnlyFence>,
    );

    const fence = screen.getByRole("group");
    expect(fence.tagName).toBe("FIELDSET");
    expect(fence).toHaveClass("contents", "extra");
    expect(screen.getByRole("button", { name: "Archive" })).toBeEnabled();
  });
});
