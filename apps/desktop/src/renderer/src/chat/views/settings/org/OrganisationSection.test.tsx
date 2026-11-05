import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SIGNED_OUT_BY_ORGANISATION, SIGNED_OUT_BY_ORGANISATION_LINE } from "@eo/core";
import { OrganisationSection } from "../sections/OrganisationSection";
import { renderSection, sent, ipcStub, type Answers } from "./testing";

/** The shared stub, installed where only a test may put it. */
function stubIpc(answers?: Answers) {
  const stub = ipcStub(answers);
  window.eo.ipc.invoke = stub.invoke as never;
  return stub.calls;
}

/**
 * Settings → Organisation in the chat layout (EO-323, ARCHITECTURE.md, "Identity"): plain
 * http to somewhere else refused on the screen before anything is sent,
 * "signed out by your organisation" said rather than an empty form, and the
 * password off the screen whatever happened.
 */

const SIGNED_IN = {
  state: "signed-in",
  address: "https://eo.example.com",
  email: "anna@example.com",
  personId: "p1",
  personName: "Anna Ruiz",
  isAdmin: false,
  deviceId: "d1",
  deviceName: "anna-macbook",
};

function mockIpc(status: unknown, answers: Record<string, unknown> = {}) {
  return stubIpc({ "session:status": status, ...answers });
}

const draw = () => renderSection(<OrganisationSection />);

function fill(address: string, password = "a memorable passphrase") {
  fireEvent.change(screen.getByLabelText("Server address"), { target: { value: address } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "anna@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

describe("signing in to an organisation, in the chat layout", () => {
  it("refuses plain http to somewhere that is not this machine, and will not let the button be pressed", async () => {
    const calls = mockIpc({ state: "signed-out" });
    draw();

    await screen.findByLabelText("Server address");
    fill("http://eo.example.com");

    expect(screen.getByText(/in the clear/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Sign in to an organisation" }));
    expect(sent(calls, "session:signIn")).toEqual([]);
  });

  it("signs in over https, from the button or from Enter", async () => {
    const calls = mockIpc({ state: "signed-out" }, { "session:signIn": { status: SIGNED_IN, problem: null } });
    draw();

    await screen.findByLabelText("Server address");
    fill("https://eo.example.com");
    fireEvent.submit(screen.getByRole("form", { name: "Sign in to an organisation" }));

    await waitFor(() => expect(sent(calls, "session:signIn")).toEqual([{ address: "https://eo.example.com", email: "anna@example.com", password: "a memorable passphrase" }]));
  });

  it("says who signed this machine out, rather than showing an empty form", async () => {
    mockIpc({ state: "revoked", address: "https://eo.example.com", email: "anna@example.com", line: SIGNED_OUT_BY_ORGANISATION_LINE });
    draw();

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(SIGNED_OUT_BY_ORGANISATION);
  });

  it("names the machine and the server when it is signed in, says what signing out does not do, and signs out", async () => {
    const calls = mockIpc(SIGNED_IN, { "session:signOut": { status: { state: "signed-out" } } });
    draw();

    expect(await screen.findByText("Anna Ruiz")).toBeInTheDocument();
    expect(screen.getByText("anna-macbook")).toBeInTheDocument();
    expect(screen.getByText("https://eo.example.com")).toBeInTheDocument();
    expect(screen.getByText(/stays in your admin's list until they revoke it/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(sent(calls, "session:signOut")).toHaveLength(1));
  });

  it("says why a sign-in was refused, in the server's own words, and clears the password", async () => {
    mockIpc({ state: "signed-out" }, { "session:signIn": { status: { state: "signed-out" }, problem: "That email address and password do not match anybody on this server." } });
    draw();

    await screen.findByLabelText("Server address");
    fill("https://eo.example.com", "not it");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/do not match anybody/)).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Server address")).toHaveValue("https://eo.example.com");
  });
});
