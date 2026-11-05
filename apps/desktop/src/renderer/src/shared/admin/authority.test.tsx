import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@eo/ui";
import type { ReactNode } from "react";
import { createQueryClient } from "../../query/client";
import { setBridge } from "../../ipc/bridge";
import { AdminAuthorityProvider, useItemAuthority } from "./authority";

/**
 * Read-only by default, and what it takes to stop being (EO-326,
 * `ARCHITECTURE.md`, "Identity").
 *
 * The distinction these cases exist to hold is the one the code would
 * look identical either way for: this is a **safety catch, not a
 * permission**. So the assertions are about what is *drawn* — a disabled
 * control with a sentence beside it, becoming an enabled one — and there
 * is deliberately no case here asserting that the record refuses
 * anything. It does not, and a test claiming otherwise would be the
 * first step towards somebody believing it.
 *
 * The second thing held here is that none of it happens on a desktop.
 * `organisation` is false there, and every screen below is exactly the
 * screen somebody working alone has always had.
 */
/**
 * A browser served by an organisation, answering `people:me` as the
 * person named.
 *
 * The transport is replaced rather than only the responses, because the
 * catch asks `machineAvailable()` before it asks anything else: it
 * errs closed *only* where an answer is still in flight, and on a
 * desktop there is nothing in flight to be careful about. A case that
 * left the desktop bridge in place would be describing a situation that
 * cannot arise.
 */
function whoAmI(person: { id: string; name: string; isAdmin: boolean } | null, organisation: boolean, settle: "now" | "never" = "now") {
  const answer = {
    ok: true as const,
    data: {
      person:
        person === null
          ? null
          : { id: person.id, name: person.name, email: null, isAdmin: person.isAdmin, invitedAt: null, acceptedAt: null, credentialKind: null },
      admin: person?.isAdmin ?? false,
      organisation,
    },
  };
  setBridge({
    invoke: (async (channel: string) =>
      // "never" is a request that is still in flight, which is what
      // every first paint is. It is held open rather than delayed, so
      // the case is about the state and not about a timer.
      settle === "never" && channel === "people:me"
        ? new Promise(() => {})
        : channel === "people:me"
          ? answer
          : { ok: true, data: {} }) as never,
    machineAvailable: false,
    subscribe: () => () => {},
    subscribeRefetch: () => () => {},
  });
}

/** A desktop: `machineAvailable` is true, and no query can change who is asking. */
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
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <AdminAuthorityProvider>{children}</AdminAuthorityProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

/** A stand-in for the controls the banner governs — a Decide button, a composer, the drag on a card. */
function AnAction({ itemId }: { itemId: string }) {
  const { readOnly } = useItemAuthority(itemId);
  return (
    <button type="button" disabled={readOnly}>
      Approve
    </button>
  );
}

/**
 * The control that takes authority over one item, reduced to the call it
 * makes (EO-529).
 *
 * The classic layout's banner was here; each layout now draws its own —
 * the chat layout's is `chat/admin/ActAsAdmin`, held to its own cases in
 * `chat/admin/admin.test.tsx`: nothing drawn on a desktop or for a
 * colleague, the sentence for an admin, the unlock and that it is per
 * item. What stays here is the provider's rule, which needs nothing but
 * the call.
 */
function TakeAuthority({ itemId }: { itemId: string }) {
  const { administering, readOnly, actAsAdmin } = useItemAuthority(itemId);
  if (!administering || !readOnly) return null;
  return (
    <button type="button" onClick={actAsAdmin}>
      Act as admin
    </button>
  );
}

describe("acting as an administrator", () => {
  it("stays shut while it does not yet know who is asking", async () => {
    // The catch has to hold during the first paint, which happens long
    // before `people:me` comes back. An admin who clicked Archive in
    // that second would have archived another team's item and then been
    // shown the banner explaining why they could not.
    whoAmI({ id: "p-dana", name: "Dana Okoro", isAdmin: true }, true, "never");
    mount(<AnAction itemId="t1" />);

    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    // And stays shut, rather than opening a tick later of its own accord.
    await new Promise((settle) => setTimeout(settle, 20));
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("does not make a desktop wait for an answer it will never need", async () => {
    // The other half, and the reason the rule asks `machineAvailable`
    // first: erring closed while loading would put every solo
    // installation's item page through a flicker of disabled controls on
    // every single load, for a question that cannot change its answer.
    onADesktop();
    mount(<AnAction itemId="t1" />);

    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("behaves as a desktop does when nothing is above it", async () => {
    // A component rendered on its own — which is most of the renderer's suite —
    // gets the answer a desktop gets, rather than a convenient blank.
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <AnAction itemId="t1" />
        </QueryClientProvider>
      </ThemeProvider>,
    );

    expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
  });
});

/**
 * The same catch, on the controls the board carries (EO-326, ARCHITECTURE.md, "Identity").
 *
 * Kept beside the provider's own cases rather than in the board's
 * suite, because what is being held is one rule reaching two screens: an
 * admin who has not taken authority over an item cannot move it, decide
 * on it, comment on it, or take it — and the board is where three of
 * those are a single gesture apiece with no room for a sentence.
 */
describe("the same catch, on a card", () => {
  it("will not let a card be dragged, and says where to say otherwise", async () => {
    whoAmI({ id: "p-dana", name: "Dana Okoro", isAdmin: true }, true);
    mount(<ACard itemId="t1" />);

    const card = await screen.findByRole("button", { name: "Open SUP-31" });
    await waitFor(() => expect(card).toHaveAttribute("title", expect.stringContaining("Act as admin")));
    // The grab cursor is the affordance; a card that cannot be lifted
    // must not go on advertising that it can.
    expect(card.className).toContain("cursor-pointer");
    expect(card.className).not.toContain("cursor-grab");
  });

  it("lifts again once the admin has said so", async () => {
    whoAmI({ id: "p-dana", name: "Dana Okoro", isAdmin: true }, true);
    mount(
      <>
        <TakeAuthority itemId="t1" />
        <ACard itemId="t1" />
      </>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Act as admin" }));

    const card = screen.getByRole("button", { name: "Open SUP-31" });
    expect(card).not.toHaveAttribute("title");
    expect(card.className).toContain("cursor-grab");
  });

  it("leaves a card alone on a desktop", async () => {
    onADesktop();
    mount(<ACard itemId="t1" />);

    const card = await screen.findByRole("button", { name: "Open SUP-31" });
    expect(card.className).toContain("cursor-grab");
    expect(card).not.toHaveAttribute("title");
  });
});

/**
 * The card's own controls, as the board draws them (`chat/views/board/BoardCard`).
 *
 * A stand-in rather than the real board, which needs a pipeline, a
 * registry and a dnd context to render at all — none of which this rule
 * has anything to do with. What it copies exactly is the two things the
 * catch touches: the class the card's surface carries, and the tooltip
 * it grows when it will not move.
 */
function ACard({ itemId }: { itemId: string }) {
  const { readOnly } = useItemAuthority(itemId);
  return (
    <button
      type="button"
      aria-label="Open SUP-31"
      {...(readOnly ? { title: "Open this item and press “Act as admin” to move it." } : {})}
      className={`absolute inset-0 ${readOnly ? "cursor-pointer" : "cursor-grab"} rounded-lg`}
    />
  );
}
