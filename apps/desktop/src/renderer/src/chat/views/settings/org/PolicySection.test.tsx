import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NO_POLICY, ORGANISATION_SECRET_LINE } from "@eo/core";
import { PolicySection } from "../sections/PolicySection";
import { renderSection, sent, ipcStub, type Call, type Answers } from "./testing";

/** The shared stub, installed where only a test may put it. */
function stubIpc(answers?: Answers) {
  const stub = ipcStub(answers);
  window.eo.ipc.invoke = stub.invoke as never;
  return stub.calls;
}

/**
 * Settings → Policy in the chat layout (EO-328, ARCHITECTURE.md, "Policy", "Secrets"): published
 * whole, "no list" told apart from "an empty list", secrets shown back as
 * neither name nor value, read-only wherever `mayPublish` is false — and a
 * draft that is the published policy until somebody edits it.
 */

const SERVERS_EMPTY = { servers: [], keychain: { available: true, backend: null, weak: false, warning: null }, managedIds: [], organisationSecrets: [], unavailable: [] };
const draw = () => renderSection(<PolicySection />);

describe("the admin's policy section", () => {
  it("publishes the allowed backends and the per-person budget together", async () => {
    const calls = stubIpc({
      "policy:get": { policy: NO_POLICY, fromServer: false, mayPublish: true, yours: null },
      "mcpServers:list": SERVERS_EMPTY,
      "policy:save": { saved: true, policy: NO_POLICY, problem: null },
    });
    draw();

    await screen.findByRole("button", { name: "Publish" });
    fireEvent.click(screen.getByRole("switch", { name: "Restrict which backends may be used" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Codex" }));
    fireEvent.change(screen.getByLabelText("Daily budget per person in cents"), { target: { value: "1000" } });
    expect(screen.getByText(/Each person may spend/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(sent(calls, "policy:save")[0]).toMatchObject({ allowedBackends: ["fake", "claude"], perPersonDailyBudgetCents: 1_000 }));
    expect(await screen.findByText("Published to every signed-in desktop.")).toBeInTheDocument();
  });

  it("tells 'no list' apart from 'an empty list'", async () => {
    const calls = stubIpc({
      "policy:get": { policy: NO_POLICY, fromServer: false, mayPublish: true, yours: null },
      "policy:save": { saved: true, policy: NO_POLICY, problem: null },
    });
    draw();

    expect(await screen.findByText("Every backend a person has signed in to may be used.")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() => expect(sent(calls, "policy:save")[0]).toMatchObject({ allowedBackends: null }));
  });

  it("says a backend left out is not allowed by the organisation", async () => {
    stubIpc({ "policy:get": { policy: { ...NO_POLICY, allowedBackends: ["claude"] }, fromServer: false, mayPublish: true, yours: null } });
    draw();

    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeChecked());
    expect(screen.getByRole("checkbox", { name: "Codex" })).not.toBeChecked();
    expect(screen.getAllByText("not allowed by your organisation").length).toBeGreaterThan(0);
  });

  it("sets a secret by name and value, shows it back as neither, and clears one", async () => {
    const calls = stubIpc({
      "policy:get": { policy: { ...NO_POLICY, secretNames: ["FLY_API_TOKEN"] }, fromServer: false, mayPublish: true, yours: null },
      "policy:setSecret": { saved: true, problem: null },
      "policy:clearSecret": { cleared: true, problem: null },
    });
    draw();

    const row = await screen.findByText("FLY_API_TOKEN");
    expect(row.parentElement).toHaveTextContent(ORGANISATION_SECRET_LINE);

    fireEvent.change(screen.getByLabelText("Secret name"), { target: { value: "SLACK_WEBHOOK" } });
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: "hook-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() => expect(sent(calls, "policy:setSecret")).toEqual([{ name: "SLACK_WEBHOOK", value: "hook-1" }]));
    await waitFor(() => expect(screen.getByLabelText("Secret value")).toHaveValue(""));

    fireEvent.click(screen.getByRole("button", { name: "Clear FLY_API_TOKEN" }));
    await waitFor(() => expect(sent(calls, "policy:clearSecret")).toEqual([{ name: "FLY_API_TOKEN" }]));
  });

  it("offers a desktop with no organisation nowhere to publish from, and says where one is", async () => {
    stubIpc({ "policy:get": { policy: NO_POLICY, fromServer: false, mayPublish: false, yours: null } });
    draw();

    expect(await screen.findByText(/Settings → Organisation/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Secret name")).not.toBeInTheDocument();
  });

  it("shows a managed desktop the policy read-only, and sends it to its admin", async () => {
    stubIpc({ "policy:get": { policy: NO_POLICY, fromServer: true, mayPublish: false, yours: null } });
    draw();

    expect(await screen.findByText(/Ask your admin to change it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Secret name")).not.toBeInTheDocument();
    expect(screen.queryByText(/Settings → Organisation/)).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Restrict which backends may be used" })).toBeInTheDocument();
  });

  it("gives a non-admin on the server the section read-only", async () => {
    stubIpc({ "policy:get": { policy: { ...NO_POLICY, secretNames: ["FLY_API_TOKEN"] }, fromServer: false, mayPublish: false, yours: null } });
    draw();

    await screen.findByText("FLY_API_TOKEN");
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear FLY_API_TOKEN" })).not.toBeInTheDocument();
  });
});

describe("an existing policy, opened to change one thing", () => {
  const GITHUB = {
    id: "019fb8c6-0000-7000-8000-0000000000a1",
    name: "github",
    description: "",
    config: { transport: "stdio" as const, command: "gh-mcp", args: [] },
    envNames: [],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    connector: null,
    secretsSet: [],
  };

  const PUBLISHED = {
    ...NO_POLICY,
    allowedBackends: ["claude"],
    perPersonDailyBudgetCents: 1_000,
    mcpServers: [{ id: GITHUB.id, name: "github", description: "", config: GITHUB.config, envNames: [] }],
    publishedAt: 5,
  };

  function openIt(): Call[] {
    const calls = stubIpc({
      "policy:get": { policy: PUBLISHED, fromServer: false, mayPublish: true, yours: null },
      "mcpServers:list": { ...SERVERS_EMPTY, servers: [GITHUB], managedIds: [GITHUB.id] },
      "policy:save": { saved: true, policy: PUBLISHED, problem: null },
    });
    draw();
    return calls;
  }

  it("draws what is published, rather than the empty policy of its first render", async () => {
    openIt();

    await waitFor(() => expect(screen.getByLabelText("Daily budget per person in cents")).toHaveValue("1000"));
    expect(screen.getByRole("switch", { name: "Restrict which backends may be used" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Built in (fake)" })).not.toBeChecked();
    expect(await screen.findByRole("checkbox", { name: "Publish github" })).toBeChecked();
  });

  it("keeps the other two settings when only one is changed", async () => {
    const calls = openIt();

    await waitFor(() => expect(screen.getByLabelText("Daily budget per person in cents")).toHaveValue("1000"));
    await screen.findByRole("checkbox", { name: "Publish github" });
    fireEvent.change(screen.getByLabelText("Daily budget per person in cents"), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(sent(calls, "policy:save")[0]).toMatchObject({ allowedBackends: ["claude"], perPersonDailyBudgetCents: 2_000, mcpServers: [{ id: GITHUB.id, name: "github" }] }),
    );
  });

  it("unpublishes a server that is unticked", async () => {
    const calls = openIt();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Publish github" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(sent(calls, "policy:save")[0]).toMatchObject({ mcpServers: [] }));
  });

  it("does not let a refetch move a field somebody is typing in", async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const calls = openIt();
    window.eo.ipc.subscribe = vi.fn((channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener);
      return () => listeners.delete(channel);
    }) as never;

    await waitFor(() => expect(screen.getByLabelText("Daily budget per person in cents")).toHaveValue("1000"));
    fireEvent.change(screen.getByLabelText("Daily budget per person in cents"), { target: { value: "25" } });

    act(() => listeners.get("config:changed")?.({}));
    await waitFor(() => expect(sent(calls, "policy:get").length).toBeGreaterThan(0));
    expect(screen.getByLabelText("Daily budget per person in cents")).toHaveValue("25");
  });
});
