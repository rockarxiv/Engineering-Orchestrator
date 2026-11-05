import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ALIAS_RETIREMENT_VERSION } from "@eo/core";
import { McpSection } from "../sections/McpSection";
import { renderSection, sent, ipcStub, type Answers } from "./testing";

/** The shared stub, installed where only a test may put it. */
function stubIpc(answers?: Answers) {
  const stub = ipcStub(answers);
  window.eo.ipc.invoke = stub.invoke as never;
  return stub.calls;
}

/**
 * Settings → MCP server in the chat layout: the switches, the port, the
 * token that can be read back, registering the apps on this machine, and
 * the alias state said to the person (KAN-178) — once per client, and for a
 * client EO cannot name too.
 */

const STATUS = { enabled: true, dangerousOperations: false, port: 4319, listeningPort: 4319, token: "test-token", problem: null, toolCount: 30 };

const CLAUDE_CODE = { id: "claude-code", label: "Claude Code", installed: true, registered: true, caveat: null, problem: null, manual: null };

const ON_OLD_NAMES = { client: "claude-code", clientId: "claude-code", names: [{ deprecated: "ticket_get", replacement: "item_get" }], lastCalledAt: "2026-09-13T10:00:00.000Z" };

function mockIpc({ oldNameUse = [] as unknown[], version = "0.0.0", clients = [CLAUDE_CODE] as unknown[], status = STATUS as unknown, answers = {} as Record<string, unknown> } = {}) {
  return stubIpc({
    "mcp:getStatus": status,
    "mcp:detectClients": { clients, oldNameUse },
    "app:getVersion": { version },
    ...answers,
  });
}

const draw = () => renderSection(<McpSection />);

describe("the MCP server section", () => {
  it("says it is listening, and turns the server and destructive operations on and off", async () => {
    const calls = mockIpc({ answers: { "mcp:setConfig": STATUS } });
    draw();

    expect(await screen.findByText("listening on 127.0.0.1:4319")).toBeInTheDocument();
    expect(screen.getByText(/a connected program gets 30 tools/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Enable the MCP server" }));
    await waitFor(() => expect(sent(calls, "mcp:setConfig")).toEqual([{ enabled: false }]));
    fireEvent.click(screen.getByRole("switch", { name: "Allow destructive operations" }));
    await waitFor(() => expect(sent(calls, "mcp:setConfig")).toContainEqual({ dangerousOperations: true }));
  });

  it("saves a port in range when the field is left, and puts back one out of range", async () => {
    const calls = mockIpc({ answers: { "mcp:setConfig": STATUS } });
    draw();

    const port = await screen.findByRole("textbox", { name: /^Port/ });
    fireEvent.change(port, { target: { value: "80" } });
    fireEvent.blur(port);
    expect(port).toHaveValue("4319");
    fireEvent.change(port, { target: { value: "5000" } });
    fireEvent.blur(port);
    await waitFor(() => expect(sent(calls, "mcp:setConfig")).toEqual([{ port: 5000 }]));
  });

  it("offers a free port when the one asked for is taken", async () => {
    const calls = mockIpc({ status: { ...STATUS, listeningPort: null, problem: "Port 4319 is in use." }, answers: { "mcp:setConfig": STATUS } });
    draw();

    expect(await screen.findByText("Port 4319 is in use.")).toBeInTheDocument();
    expect(screen.getByText("not listening")).toBeInTheDocument();
    expect(screen.getByText(/Turn the server on first/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pick a free port" }));
    await waitFor(() => expect(sent(calls, "mcp:setConfig")).toEqual([{ port: 0 }]));
  });

  it("hides the token until revealed, and regenerates it", async () => {
    const calls = mockIpc({ answers: { "mcp:regenerateToken": { ...STATUS, token: "fresh" } } });
    draw();

    const token = await screen.findByLabelText("The token");
    expect(token).not.toHaveTextContent("test-token");
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(token).toHaveTextContent("test-token");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(sent(calls, "mcp:regenerateToken")).toHaveLength(1));
    await waitFor(() => expect(screen.getByLabelText("The token")).not.toHaveTextContent("fresh"));
  });

  it("shows the connection command for each client, with the real token", async () => {
    mockIpc();
    draw();

    fireEvent.click(await screen.findByRole("tab", { name: "Codex" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent('Authorization = "Bearer test-token"');
  });

  it("never puts the token in an argument of a command it shows, only in the line that sets a variable", async () => {
    // A pasted argument is on a command line every user on the machine can
    // read, and in shell history (EO-601).
    mockIpc();
    draw();

    const tokenLines = async (tab: string) => {
      fireEvent.click(await screen.findByRole("tab", { name: tab }));
      const text = screen.getByRole("tabpanel").textContent ?? "";
      return text.split("\n").filter((line) => line.includes("test-token"));
    };

    expect(await tokenLines("Claude Code")).toEqual(["export EO_MCP_TOKEN=test-token"]);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("--header 'Authorization: Bearer ${EO_MCP_TOKEN}'");
    expect(await tokenLines("Anything else")).toEqual(["export EO_MCP_HEADER='Bearer test-token'"]);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("npx -y mcp-remote http://127.0.0.1:4319/mcp --header 'Authorization:${EO_MCP_HEADER}'");
  });

  it("adds EO to an app that has not got it, and offers the command to run by hand", async () => {
    const calls = mockIpc({
      clients: [{ ...CLAUDE_CODE, registered: false, manual: { label: "Run this in a terminal", text: "claude mcp add eo" } }],
      answers: { "mcp:registerWith": { ok: true } },
    });
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Add EO" }));
    await waitFor(() => expect(sent(calls, "mcp:registerWith")).toEqual([{ id: "claude-code" }]));
    fireEvent.click(screen.getByRole("button", { name: "or do it yourself" }));
    expect(screen.getByText("claude mcp add eo")).toBeInTheDocument();
  });

  it("says an app is not installed", async () => {
    mockIpc({ clients: [{ ...CLAUDE_CODE, installed: false }] });
    draw();
    expect(await screen.findByText("not installed")).toBeInTheDocument();
  });
});

describe("a client still calling ticket_*", () => {
  it("says so on its row, and offers the new names", async () => {
    mockIpc({ oldNameUse: [ON_OLD_NAMES] });
    draw();

    expect(await screen.findByText(`uses ticket_* names · retired after v${ALIAS_RETIREMENT_VERSION}`)).toBeInTheDocument();
    expect(screen.queryByText("ticket_get")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show the new names" }));
    expect(screen.getByText("ticket_get")).toBeInTheDocument();
    expect(screen.getByText("item_get")).toBeInTheDocument();
  });

  it("says nothing about a client that has moved", async () => {
    mockIpc();
    draw();
    expect(await screen.findByText("added")).toBeInTheDocument();
    expect(screen.queryByText(/uses ticket_\* names/)).not.toBeInTheDocument();
  });

  it("changes what it says once the retirement release is the one running", async () => {
    mockIpc({ oldNameUse: [ON_OLD_NAMES], version: `${ALIAS_RETIREMENT_VERSION}.0` });
    draw();
    expect(await screen.findByText("uses ticket_* names · this client will stop working on update")).toBeInTheDocument();
  });

  it("gives a client EO cannot name a row under its own name", async () => {
    mockIpc({ oldNameUse: [{ ...ON_OLD_NAMES, client: "some-script", clientId: null }] });
    draw();
    expect(await screen.findByText(/^some-script uses ticket_\* names/)).toBeInTheDocument();
  });

  it("still shows the row when detection does not return the client it belongs to, and once when it does", async () => {
    mockIpc({ oldNameUse: [ON_OLD_NAMES], clients: [] });
    const { unmount } = draw();
    expect(await screen.findByText(/^claude-code uses ticket_\* names/)).toBeInTheDocument();
    unmount();

    mockIpc({ oldNameUse: [ON_OLD_NAMES] });
    draw();
    expect(await screen.findAllByText(/uses ticket_\* names/)).toHaveLength(1);
  });
});
