import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { developerRegistry, toRegistryView, type CliTool } from "@eo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../../../query/client";
import { setBridge } from "../../../ipc/bridge";
import { AgentToolsView } from "./AgentToolsView";

/**
 * The CLIs panel on the Agent tools screen (EO-821).
 *
 * What it must get right: a command typed in is checked on this machine
 * and its drafted description fills the box, and nothing reaches
 * `cliTools:save` until the person presses Add; each row says whether
 * its command is installed here; and a tick reaches `agentCliTools:set`,
 * never `agentAttachments:set`, which EO's system agent can reach.
 */

const GH: CliTool = {
  id: "019fb8c6-0000-7000-8000-0000000000d1",
  name: "GitHub CLI",
  command: "gh",
  description: "Reads and opens pull requests and issues.",
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
};

const KUBECTL: CliTool = {
  id: "019fb8c6-0000-7000-8000-0000000000d2",
  name: "kubectl",
  command: "kubectl",
  description: "",
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
};

const REVIEWER = { id: "019fb8c6-0000-7000-8000-0000000000c1", name: "Reviewer", role: "reviewer", provider: "claude", model: null, enabled: true, archivedAt: null };

const FOUND = { detection: { found: true, path: "/usr/bin/gh", version: "gh version 2.62.0 (2026-10-01)" } };
const MISSING = { detection: { found: false } };

type Answer = unknown | ((payload: unknown) => unknown);

const DEFAULTS: Record<string, Answer> = {
  "mcpServers:list": { servers: [], keychain: { available: true, backend: "gnome_libsecret", weak: false, warning: null } },
  "skills:list": { skills: [] },
  "cliTools:list": { cliTools: [] },
  "agents:list": { agents: [] },
  "agentAttachments:list": { attachments: [] },
  "agentCliTools:list": { attachments: [] },
  "cliTools:detect": MISSING,
  "cliTools:draft": { draft: { version: null, description: "" } },
  "registry:get": toRegistryView(developerRegistry()),
};

function mockIpc(answers: Record<string, Answer> = {}) {
  const calls: { channel: string; payload: unknown }[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    const answer = channel in answers ? answers[channel] : (DEFAULTS[channel] ?? {});
    return { ok: true, data: typeof answer === "function" ? (answer as (payload: unknown) => unknown)(payload) : answer };
  }) as never;
  return calls;
}

const sent = (calls: { channel: string; payload: unknown }[], channel: string) => calls.filter((call) => call.channel === channel).map((call) => call.payload);

async function openClis() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/agent-tools"]}>
        <AgentToolsView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("tab", { name: /CLIs/ }));
}

afterEach(() => setBridge(undefined));

describe("the CLIs panel", () => {
  it("lists every live CLI with its command, description and whether it is installed here", async () => {
    const calls = mockIpc({
      "cliTools:list": { cliTools: [GH, KUBECTL, { ...KUBECTL, id: "019fb8c6-0000-7000-8000-0000000000d3", name: "terraform", command: "terraform", archivedAt: 5 }] },
      "cliTools:detect": (payload: unknown) => ((payload as { command: string }).command === "gh" ? FOUND : MISSING),
    });
    await openClis();

    const gh = await screen.findByRole("region", { name: "GitHub CLI" });
    expect(within(gh).getByText("gh")).toBeInTheDocument();
    expect(within(gh).getByText("Reads and opens pull requests and issues.")).toBeInTheDocument();
    expect(await within(gh).findByText("Found")).toBeInTheDocument();
    expect(within(gh).getByText("/usr/bin/gh")).toBeInTheDocument();
    expect(within(gh).getByText("gh version 2.62.0 (2026-10-01)")).toBeInTheDocument();

    const kubectl = screen.getByRole("region", { name: "kubectl" });
    expect(await within(kubectl).findByText("Not found on this machine")).toBeInTheDocument();

    // Archived rows are kept and hidden until asked for.
    expect(screen.queryByRole("region", { name: "terraform" })).toBeNull();
    expect(screen.getByRole("tab", { name: /CLIs/ })).toHaveTextContent("2");
    expect(sent(calls, "cliTools:detect")).toEqual(expect.arrayContaining([{ command: "gh" }, { command: "kubectl" }]));
  });

  it("checks a command that is installed, pre-fills its drafted description, and saves only when told to", async () => {
    const calls = mockIpc({
      "cliTools:detect": FOUND,
      "cliTools:draft": { draft: { version: "gh version 2.62.0 (2026-10-01)", description: "Work seamlessly with GitHub from the command line." } },
      "cliTools:save": { saved: true, cliTool: GH, problem: null },
    });
    await openClis();

    fireEvent.click(await screen.findByRole("button", { name: "New CLI" }));
    fireEvent.change(screen.getByLabelText(/^Command/), { target: { value: "gh" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    const result = await screen.findByRole("status", { name: "What this machine has" });
    expect(within(result).getByText("Found")).toBeInTheDocument();
    expect(within(result).getByText("/usr/bin/gh")).toBeInTheDocument();
    expect(within(result).getByText("gh version 2.62.0 (2026-10-01)")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^What it is/)).toHaveValue("Work seamlessly with GitHub from the command line."));
    expect(sent(calls, "cliTools:detect")).toEqual([{ command: "gh" }]);
    expect(sent(calls, "cliTools:draft")).toEqual([{ command: "gh" }]);
    // A draft on screen is not a row in the catalogue.
    expect(sent(calls, "cliTools:save")).toEqual([]);

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "GitHub CLI" } });
    fireEvent.change(screen.getByLabelText(/^What it is/), { target: { value: "Reads and opens pull requests and issues." } });
    fireEvent.click(screen.getByRole("button", { name: "Add CLI" }));

    await waitFor(() => expect(sent(calls, "cliTools:save")).toHaveLength(1));
    expect(sent(calls, "cliTools:save")[0]).toEqual({ name: "GitHub CLI", command: "gh", description: "Reads and opens pull requests and issues." });
    await waitFor(() => expect(screen.queryByRole("region", { name: "CLI editor" })).toBeNull());
  });

  it("says a missing command is not found, drafts nothing and saves nothing", async () => {
    const calls = mockIpc({ "cliTools:detect": MISSING, "cliTools:draft": { draft: { version: null, description: "" } } });
    await openClis();

    fireEvent.click(await screen.findByRole("button", { name: "New CLI" }));
    const command = screen.getByLabelText(/^Command/);
    fireEvent.change(command, { target: { value: "acme-deploy" } });
    // Leaving the box is enough to ask.
    fireEvent.blur(command);

    const result = await screen.findByRole("status", { name: "What this machine has" });
    expect(within(result).getByText("Not found on this machine")).toBeInTheDocument();
    expect(screen.getByLabelText(/^What it is/)).toHaveValue("");
    expect(sent(calls, "cliTools:detect")).toEqual([{ command: "acme-deploy" }]);
    expect(sent(calls, "cliTools:save")).toEqual([]);
  });

  it("never replaces a description the person wrote with a draft", async () => {
    mockIpc({ "cliTools:detect": FOUND, "cliTools:draft": { draft: { version: "2", description: "Drafted words." } } });
    await openClis();

    fireEvent.click(await screen.findByRole("button", { name: "New CLI" }));
    fireEvent.change(screen.getByLabelText(/^What it is/), { target: { value: "My own words." } });
    fireEvent.change(screen.getByLabelText(/^Command/), { target: { value: "gh" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    await screen.findByRole("status", { name: "What this machine has" });
    expect(screen.getByLabelText(/^What it is/)).toHaveValue("My own words.");
  });

  it("refuses to check a command with arguments in it, without asking the machine", async () => {
    const calls = mockIpc();
    await openClis();

    fireEvent.click(await screen.findByRole("button", { name: "New CLI" }));
    fireEvent.change(screen.getByLabelText(/^Command/), { target: { value: "gh pr" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    expect(await screen.findByText(/has a space in it/)).toBeInTheDocument();
    expect(sent(calls, "cliTools:detect")).toEqual([]);
  });

  it("gives a CLI to an agent and takes it away through agentCliTools:set", async () => {
    let held: string[] = [];
    const calls = mockIpc({
      "cliTools:list": { cliTools: [GH] },
      "agents:list": { agents: [REVIEWER] },
      "agentCliTools:list": () => ({ attachments: held.length === 0 ? [] : [{ agentId: REVIEWER.id, cliToolIds: held }] }),
      "agentCliTools:set": (payload: unknown) => {
        const tick = payload as { cliToolId: string; attached: boolean };
        held = tick.attached ? [tick.cliToolId] : [];
        return { attachments: { agentId: REVIEWER.id, cliToolIds: held }, problem: null };
      },
    });
    await openClis();

    const box = await screen.findByRole("checkbox", { name: "Reviewer gets GitHub CLI" });
    expect(box).not.toBeChecked();
    fireEvent.click(box);

    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Reviewer gets GitHub CLI" })).toBeChecked());
    expect(sent(calls, "agentCliTools:set")).toEqual([{ agentId: REVIEWER.id, cliToolId: GH.id, attached: true }]);
    // Read back from the agent's attachments, not only drawn from the click.
    expect(sent(calls, "agentCliTools:list").length).toBeGreaterThanOrEqual(2);
    expect(sent(calls, "agentAttachments:set")).toEqual([]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Reviewer gets GitHub CLI" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Reviewer gets GitHub CLI" })).not.toBeChecked());
    expect(sent(calls, "agentCliTools:set")[1]).toEqual({ agentId: REVIEWER.id, cliToolId: GH.id, attached: false });
  });

  it("says a refused tick on screen", async () => {
    mockIpc({
      "cliTools:list": { cliTools: [GH] },
      "agents:list": { agents: [REVIEWER] },
      "agentCliTools:set": { attachments: null, problem: "That command-line tool no longer exists." },
    });
    await openClis();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Reviewer gets GitHub CLI" }));
    expect(await screen.findByText("That command-line tool no longer exists.")).toBeInTheDocument();
  });

  it("edits a CLI in place, keeping its id", async () => {
    const calls = mockIpc({ "cliTools:list": { cliTools: [GH] }, "cliTools:save": { saved: true, cliTool: GH, problem: null } });
    await openClis();

    const row = await screen.findByRole("region", { name: "GitHub CLI" });
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText(/^Command/)).toHaveValue("gh");
    fireEvent.change(screen.getByLabelText(/^What it is/), { target: { value: "Use it for every GitHub task." } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(sent(calls, "cliTools:save")).toHaveLength(1));
    expect(sent(calls, "cliTools:save")[0]).toEqual({ id: GH.id, name: "GitHub CLI", command: "gh", description: "Use it for every GitHub task." });
  });

  it("keeps a refused save in the editor", async () => {
    mockIpc({ "cliTools:save": { saved: false, cliTool: null, problem: "A command-line tool needs a name." } });
    await openClis();

    fireEvent.click(await screen.findByRole("button", { name: "New CLI" }));
    fireEvent.change(screen.getByLabelText(/^Command/), { target: { value: "gh" } });
    fireEvent.click(screen.getByRole("button", { name: "Add CLI" }));

    expect(await screen.findByText("A command-line tool needs a name.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "CLI editor" })).toBeInTheDocument();
  });

  it("archives a live CLI and restores an archived one", async () => {
    const archived = { ...KUBECTL, archivedAt: 5 };
    const calls = mockIpc({
      "cliTools:list": { cliTools: [GH, archived] },
      "cliTools:archive": { archived: true, problem: null },
      "cliTools:restore": { restored: true, problem: null },
    });
    await openClis();

    fireEvent.click(within(await screen.findByRole("region", { name: "GitHub CLI" })).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(sent(calls, "cliTools:archive")).toEqual([{ id: GH.id }]));

    fireEvent.click(screen.getByRole("button", { name: "Show archived (1)" }));
    const row = await screen.findByRole("region", { name: "kubectl" });
    expect(within(row).getByText("Archived")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(sent(calls, "cliTools:restore")).toEqual([{ id: KUBECTL.id }]));
  });

  it("does not ask the organisation's server what is installed on a desktop", async () => {
    const calls: string[] = [];
    const invoke = vi.fn(async (channel: string) => {
      calls.push(channel);
      return { ok: true, data: channel === "cliTools:list" ? { cliTools: [GH] } : (DEFAULTS[channel] ?? {}) };
    });
    setBridge({ invoke: invoke as never, machineAvailable: false, subscribe: () => () => {}, subscribeRefetch: () => () => {} });
    await openClis();

    const row = await screen.findByRole("region", { name: "GitHub CLI" });
    expect(within(row).getByText("Not checked here")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New CLI" }));
    expect(screen.getByRole("button", { name: "Check" })).toBeDisabled();
    expect(calls).not.toContain("cliTools:detect");
    expect(calls).not.toContain("cliTools:draft");
  });
});
