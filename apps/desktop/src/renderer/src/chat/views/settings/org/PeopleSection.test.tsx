import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as bridgeModule from "../../../../ipc/bridge";
import { PeopleSection } from "../sections/PeopleSection";
import { renderSection, sent, ipcStub, type Answers } from "./testing";

/** The shared stub, installed where only a test may put it. */
function stubIpc(answers?: Answers) {
  const stub = ipcStub(answers);
  window.eo.ipc.invoke = stub.invoke as never;
  return stub.calls;
}

/**
 * Settings → People in the chat layout (EO-323, ARCHITECTURE.md, "Identity"): devices with a
 * name and a last-seen line and Revoke beside them, invitations shown as a
 * link because EO sends no mail, groups edited as the whole set, and no
 * Invite or Devices where there is no organisation.
 */

const ANNA = { id: "p1", name: "Anna Ruiz", email: "anna@example.com", isAdmin: false, invitedAt: 1, acceptedAt: 2, credentialKind: "password" };
const BO = { id: "p2", name: "Bo Chen", email: "bo@example.com", isAdmin: true, invitedAt: 3, acceptedAt: null, credentialKind: null };
const DEVICE = { id: "d1", personId: "p1", personName: "Anna Ruiz", name: "anna-macbook", createdAt: 1, lastSeenAt: Date.now(), revokedAt: null };

function mockIpc(overrides: Record<string, unknown> = {}) {
  return stubIpc({
    "people:list": { people: [ANNA, BO], groups: [{ id: "g1", name: "Support team", memberIds: ["p1"] }], fromServer: true },
    "devices:list": { devices: [DEVICE], problem: null },
    ...overrides,
  });
}

const draw = () => renderSection(<PeopleSection />);

afterEach(() => vi.restoreAllMocks());

describe("the People section, in the chat layout", () => {
  it("shows a device with its machine's name, who holds it and when it was last seen, and revokes it by device", async () => {
    const calls = mockIpc();
    draw();

    const devices = within(await screen.findByRole("list", { name: "Devices" }));
    expect(devices.getByText("anna-macbook")).toBeInTheDocument();
    expect(devices.getByText(/Anna Ruiz · last seen/)).toBeInTheDocument();
    fireEvent.click(devices.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(sent(calls, "devices:revoke")).toEqual([{ deviceId: "d1" }]));
  });

  it("says a server it could not reach could not be reached, rather than 'nobody has signed in'", async () => {
    mockIpc({ "devices:list": { devices: [], problem: "EO could not reach https://eo.example.com: connection refused" } });
    draw();

    expect(await screen.findByText(/could not reach/)).toBeInTheDocument();
    expect(screen.queryByText("Nobody has signed in from a desktop yet.")).not.toBeInTheDocument();
  });

  it("says nobody has signed in when the list really is empty", async () => {
    mockIpc({ "devices:list": { devices: [], problem: null } });
    draw();
    expect(await screen.findByText("Nobody has signed in from a desktop yet.")).toBeInTheDocument();
  });

  it("says a revoked device is revoked rather than hiding it", async () => {
    mockIpc({ "devices:list": { devices: [{ ...DEVICE, revokedAt: Date.now() }], problem: null } });
    draw();

    expect(await screen.findByText("revoked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("tells an outstanding invitation from a colleague who has joined, and who is an admin", async () => {
    mockIpc();
    draw();

    expect(await screen.findByText("invited")).toBeInTheDocument();
    expect(screen.getByText("signs in with a password")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
  });

  it("makes somebody an admin, and takes it away from somebody who is one", async () => {
    const calls = mockIpc({ "people:setAdmin": { problem: null } });
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Make admin" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove admin" }));
    await waitFor(() =>
      expect(sent(calls, "people:setAdmin")).toEqual([
        { personId: "p1", isAdmin: true },
        { personId: "p2", isAdmin: false },
      ]),
    );
  });

  it("invites by email and shows the link to send, because EO sends no mail", async () => {
    const calls = mockIpc({ "people:invite": { person: ANNA, invitePath: "/invite/a-one-time-code", expiresAt: Date.now() + 1000, problem: null } });
    draw();

    const email = await screen.findByLabelText("Email");
    expect(screen.getByRole("button", { name: "Invite" })).toBeDisabled();
    fireEvent.change(email, { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Administrator" }));
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    expect(await screen.findByText(/EO does not send email/)).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/invite/a-one-time-code`)).toBeInTheDocument();
    expect(sent(calls, "people:invite")[0]).toEqual({ email: "new@example.com", isAdmin: true });
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveValue(""));
  });

  it("says why an invitation was refused, in the server's own words", async () => {
    mockIpc({ "people:invite": { person: null, invitePath: null, expiresAt: null, problem: "anna@example.com is already on this organisation's list." } });
    draw();

    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "anna@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    expect(await screen.findByText(/already on this organisation/)).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("anna@example.com");
  });

  it("edits a group's membership as the whole set, which is what the channel writes", async () => {
    const calls = mockIpc({ "groups:save": { group: { id: "g1", name: "Support team", memberIds: ["p1", "p2"] }, problem: null } });
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Members" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Bo Chen in Support team" }));
    fireEvent.click(screen.getByRole("button", { name: "Save members" }));

    await waitFor(() => expect(sent(calls, "groups:save")).toEqual([{ id: "g1", name: "Support team", memberIds: ["p1", "p2"] }]));
  });

  it("adds a group and deletes one", async () => {
    const calls = mockIpc({ "groups:save": { group: null, problem: null }, "groups:delete": { problem: null } });
    draw();

    fireEvent.change(await screen.findByLabelText("Group name"), { target: { value: " Billing " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(sent(calls, "groups:save")).toEqual([{ name: "Billing", memberIds: [] }]));

    fireEvent.click(within(screen.getByRole("list", { name: "Groups" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(sent(calls, "groups:delete")).toEqual([{ groupId: "g1" }]));
  });
});

describe("a desktop with no organisation", () => {
  it("offers no Invite and no Devices, and says where signing in is", async () => {
    mockIpc({ "people:list": { people: [ANNA], groups: [], fromServer: false } });
    draw();

    expect(await screen.findByText(/Inviting somebody needs an organisation server/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Devices" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument();
    expect(screen.getByLabelText("Group name")).toBeInTheDocument();
  });

  it("offers both in the browser an admin opened the server's address in", async () => {
    vi.spyOn(bridgeModule, "machineAvailable").mockReturnValue(false);
    mockIpc({ "people:list": { people: [ANNA], groups: [], fromServer: false } });
    draw();

    expect(await screen.findByRole("button", { name: "Invite" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Devices" })).toBeInTheDocument();
  });
});
