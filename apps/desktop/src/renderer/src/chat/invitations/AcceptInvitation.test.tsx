import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "@eo/ui";
import { describe, expect, it, vi } from "vitest";
import { invitationCodeFrom, invitationPath } from "@eo/core";
import { createQueryClient } from "../../query/client";
import { DEFAULT_PRESET_ID, paletteOf } from "../theme";
import { AcceptInvitation, InvitationGate } from "./AcceptInvitation";

/**
 * Accepting an invitation (EO-323, ARCHITECTURE.md, "Identity").
 *
 * The screen a person who is not yet anybody sees, reached by a link
 * rather than by a route — see `InvitationGate` for why that distinction
 * is the whole reason this is a gate.
 */

function mockIpc(overrides: Record<string, unknown> = {}) {
  const calls: { channel: string; payload: unknown }[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel in overrides) return { ok: true, data: overrides[channel] };
    return { ok: true, data: {} };
  }) as never;
  return calls;
}

function renderAccept(code = "a-one-time-code") {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <AcceptInvitation code={code} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const ACCEPTED = { accepted: { personId: "p1", name: "Anna Ruiz", email: "anna@example.com", credentialKind: "password" }, problem: null };

describe("the invitation link", () => {
  it("carries the code as its last segment, and survives the round trip", () => {
    const code = "a code/with+awkward=characters";

    expect(invitationCodeFrom(invitationPath(code))).toBe(code);
  });

  it("is not read out of any other address", () => {
    expect(invitationCodeFrom("/project")).toBeNull();
    expect(invitationCodeFrom("/invite/")).toBeNull();
    expect(invitationCodeFrom("/invite/%")).toBeNull();
  });

  it("lets the app through when the window is not on one", () => {
    render(<InvitationGate>the app</InvitationGate>);

    expect(screen.getByText("the app")).toBeInTheDocument();
  });
});

describe("accepting", () => {
  it("sets a password and records that a password is what was chosen", async () => {
    const calls = mockIpc({ "auth:acceptInvitation": ACCEPTED });
    renderAccept();

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Anna Ruiz" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a memorable passphrase" } });
    fireEvent.change(screen.getByLabelText("Password again"), { target: { value: "a memorable passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => expect(calls.some((call) => call.channel === "auth:acceptInvitation")).toBe(true));
    // No `credentialKind` on the wire: there is one kind, so there is
    // nothing to choose and nothing to send. What is recorded is what
    // the main process stored.
    expect(calls.find((call) => call.channel === "auth:acceptInvitation")?.payload).toEqual({
      code: "a-one-time-code",
      password: "a memorable passphrase",
      name: "Anna Ruiz",
    });

    // And then says where to go next, which is the desktop app.
    expect(await screen.findByText(/Welcome, Anna Ruiz/)).toBeInTheDocument();
    expect(screen.getByText(/Settings → Organisation/)).toBeInTheDocument();
  });

  it("will not send a password that is too short or typed twice differently", () => {
    mockIpc({ "auth:acceptInvitation": ACCEPTED });
    renderAccept();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
    expect(screen.getByText(/at least 12 characters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a memorable passphrase" } });
    fireEvent.change(screen.getByLabelText("Password again"), { target: { value: "a memorable passphrasf" } });
    expect(screen.getByText("Those two do not match.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
  });

  it("says a link that does not work does not work, and stays on the form", async () => {
    mockIpc({ "auth:acceptInvitation": { accepted: null, problem: "That invitation link is not one this server is waiting for." } });
    renderAccept();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a memorable passphrase" } });
    fireEvent.change(screen.getByLabelText("Password again"), { target: { value: "a memorable passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(await screen.findByText(/not one this server is waiting for/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
  });

  /** Above both layouts, so in the chat layout's look, in a browser that has chosen no theme (EO-527). */
  it("is drawn in the default chat theme in a browser that has chosen none", () => {
    mockIpc();
    renderAccept();

    expect(screen.getByRole("heading", { name: "Join this EO server" })).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue("--color-canvas")).toBe(paletteOf({ kind: "preset", id: DEFAULT_PRESET_ID })["--color-canvas"]);
  });

  it("offers no passkey, not even in a browser that has one", () => {
    // "A passkey through the browser's WebAuthn if the platform provides
    // it, else a password" — and the platform that does not provide it
    // is EO, not the browser: nothing here registers a credential and
    // nothing on the far side verifies an assertion. Offering the choice
    // anyway was a control that did nothing (invariant 12) *and* a record
    // that said "passkey" about a password. Neither is offered now, and
    // this is the case that stops the radio button reappearing without
    // the flow under it.
    vi.stubGlobal("PublicKeyCredential", class {});
    mockIpc({ "auth:acceptInvitation": ACCEPTED });
    renderAccept();

    expect(screen.queryByLabelText("A passkey")).not.toBeInTheDocument();
    expect(screen.queryByText(/passkey/i)).not.toBeInTheDocument();
    // What is offered is the credential this server can actually check.
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
