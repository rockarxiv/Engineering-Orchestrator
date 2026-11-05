import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ConnectorView } from "@eo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as bridgeModule from "../../ipc/bridge";
import { renderSection, sent, ipcStub, type Answers } from "../views/settings/org/testing";
import { ConnectorNeeds } from "./ConnectorNeeds";

/** The shared stub, installed where only a test may put it. */
function stubIpc(answers?: Answers) {
  const stub = ipcStub(answers);
  window.eo.ipc.invoke = stub.invoke as never;
  return stub.calls;
}

/**
 * "What this agent can reach", and the needs-check line under it (EO-315,
 * ARCHITECTURE.md, "A connector is an MCP server with a setup flow", "What a person sees first"),
 * in the chat
 * layout: a red line says why and carries the one button that fixes it;
 * the capability, never a tool id; a `none` connector with no button.
 */

const KEYCHAIN = { available: true, backend: "gnome_libsecret", weak: false, warning: null };

function connector(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return {
    serverId: "019fb8c6-0000-7000-8000-0000000000a1",
    serverName: "slack",
    label: "Slack",
    capability: "reads and posts in your Slack channels",
    setup: "token",
    secretNames: ["SLACK_BOT_TOKEN"],
    secretsSet: [],
    connected: false,
    problem: "Slack is not connected yet — EO still needs SLACK_BOT_TOKEN.",
    deliverable: true,
    ...overrides,
  };
}

function mockIpc(connectors: ConnectorView[], answers: Record<string, unknown> = {}) {
  return stubIpc({ "connectors:list": { connectors, keychain: KEYCHAIN }, ...answers });
}

afterEach(() => vi.restoreAllMocks());

describe("the reach list, in the chat layout", () => {
  it("draws a disconnected connector red, with its capability line, why, and a Connect button", async () => {
    mockIpc([connector()]);
    renderSection(<ConnectorNeeds role="reporter" empty="nothing" />);

    const line = await screen.findByText(/reads and posts in your Slack channels/);
    expect(line).toHaveTextContent("Slack — reads and posts in your Slack channels");
    expect(line).toHaveClass("text-danger");
    expect(screen.getByText("Slack is not connected yet — EO still needs SLACK_BOT_TOKEN.")).toHaveClass("text-danger");
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("asks the channel about the role it was given", async () => {
    const calls = mockIpc([connector()]);
    renderSection(<ConnectorNeeds role="reporter" empty="nothing" />);

    await screen.findByText(/reads and posts/);
    expect(sent(calls, "connectors:list")[0]).toEqual({ role: "reporter" });
  });

  it("narrows to the servers it was asked about", async () => {
    mockIpc([connector(), connector({ serverName: "github", label: "GitHub", capability: "opens pull requests" })]);
    renderSection(<ConnectorNeeds role={null} empty="nothing" servers={["github"]} />);

    expect(await screen.findByText(/opens pull requests/)).toBeInTheDocument();
    expect(screen.queryByText(/reads and posts/)).not.toBeInTheDocument();
  });

  it("stores what was pasted under the name the connector declared, and tells the caller", async () => {
    const calls = mockIpc([connector()], { "connectors:connectToken": { connected: true, problem: null, keychain: KEYCHAIN } });
    const onChanged = vi.fn();
    renderSection(<ConnectorNeeds role="reporter" empty="nothing" onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(screen.getByRole("button", { name: "Connect Slack" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Value for SLACK_BOT_TOKEN on Slack"), { target: { value: "xoxb-typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));

    await waitFor(() =>
      expect(sent(calls, "connectors:connectToken")).toEqual([{ serverId: "019fb8c6-0000-7000-8000-0000000000a1", values: { SLACK_BOT_TOKEN: "xoxb-typed" } }]),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("says why a refused value was refused, and keeps it in the box", async () => {
    mockIpc([connector()], { "connectors:connectToken": { connected: false, problem: "Slack said that token is not valid.", keychain: KEYCHAIN } });
    renderSection(<ConnectorNeeds role="reporter" empty="nothing" />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    fireEvent.change(screen.getByLabelText("Value for SLACK_BOT_TOKEN on Slack"), { target: { value: "xoxb-wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));

    expect(await screen.findByText("Slack said that token is not valid.")).toBeInTheDocument();
    expect(screen.getByLabelText("Value for SLACK_BOT_TOKEN on Slack")).toHaveValue("xoxb-wrong");
  });

  it("refuses to send a value to a keychain that cannot hold one, and says why", async () => {
    stubIpc({ "connectors:list": { connectors: [connector()], keychain: { available: true, backend: "basic_text", weak: true, warning: "Your keychain stores values in plain text." } } });
    renderSection(<ConnectorNeeds role="reporter" empty="nothing" />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    fireEvent.change(screen.getByLabelText("Value for SLACK_BOT_TOKEN on Slack"), { target: { value: "xoxb" } });
    expect(screen.getByText("Your keychain stores values in plain text.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Slack" })).toBeDisabled();
  });

  it("signs in through the provider rather than asking for a value, when the kind is oauth", async () => {
    const calls = mockIpc([connector({ setup: "oauth", problem: "Slack is not connected yet — signing in stores SLACK_BOT_TOKEN." })], {
      "connectors:connectOAuth": { connected: true, problem: null },
    });
    renderSection(<ConnectorNeeds role="reporter" empty="nothing" />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() => expect(sent(calls, "connectors:connectOAuth")).toHaveLength(1));
    expect(screen.queryByLabelText("Value for SLACK_BOT_TOKEN on Slack")).not.toBeInTheDocument();
  });

  it("offers no oauth Connect where there is no browser on this machine (EO-319)", async () => {
    vi.spyOn(bridgeModule, "machineAvailable").mockReturnValue(false);
    mockIpc([connector({ setup: "oauth" })]);
    renderSection(<ConnectorNeeds role="reporter" empty="nothing" />);

    await screen.findByText(/reads and posts/);
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("disconnects a connected one that holds values", async () => {
    const calls = mockIpc([connector({ connected: true, problem: null, secretsSet: ["SLACK_BOT_TOKEN"] })], {
      "connectors:disconnect": { disconnected: true, problem: null },
    });
    renderSection(<ConnectorNeeds role="reporter" empty="nothing" />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(sent(calls, "connectors:disconnect")).toEqual([{ serverId: "019fb8c6-0000-7000-8000-0000000000a1" }]));
  });

  it("lists a connector with nothing to connect, green and without a button", async () => {
    mockIpc([
      connector({
        serverId: null,
        serverName: "repo",
        label: "Repository intelligence",
        capability: "reads the code in the repository this step works on",
        setup: "none",
        secretNames: [],
        connected: true,
        problem: null,
      }),
    ]);
    renderSection(<ConnectorNeeds role="implementer" empty="nothing" />);

    const line = await screen.findByText(/reads the code in the repository this step works on/);
    expect(line).toHaveClass("text-ink");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says a connected connector reaches nothing while its server is switched off", async () => {
    mockIpc([connector({ connected: true, problem: null, secretsSet: ["SLACK_BOT_TOKEN"], deliverable: false })]);
    renderSection(<ConnectorNeeds role="reporter" empty="nothing" />);

    expect(await screen.findByText(/is switched off, so no dispatch is given it/)).toBeInTheDocument();
  });

  it("says so rather than drawing an empty list", async () => {
    mockIpc([]);
    renderSection(<ConnectorNeeds role={null} empty="No pack on this installation ships a connector yet." />);

    expect(await screen.findByText("No pack on this installation ships a connector yet.")).toBeInTheDocument();
  });
});
