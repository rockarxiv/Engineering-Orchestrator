import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { developerRegistry, ORGANISATION_SECRET_LINE, toRegistryView, type McpServerView, type SkillListEntry } from "@eo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../../query/client";
import { setBridge } from "../../../ipc/bridge";
import { AgentToolsView as AgentTools } from "./AgentToolsView";
import { AgentToolPicker } from "./attach";
import { ViewPublisher } from "../../../shared/view/ViewPublisher";
import { MemoryRouter } from "react-router-dom";

/**
 * The chat layout's Agent tools view, held to every case the classic
 * screen's tests (`agentTools/AgentTools.test.tsx`) hold that one to:
 * the same channels, payloads, refusals and publications.
 *
 * Originally:  * The catalogue screen, and the ticking that carries an entry to an
 * agent (EO-109).
 *
 * Three things are worth asserting here and the rest is layout. That a
 * person can define an entry and it leaves as the draft the contract
 * expects; that a tick reaches `agentAttachments:set` from either end;
 * and that a refusal — whether it comes back as a `problem` or as a
 * rejected envelope — is a sentence on screen rather than an unhandled
 * throw. The fourth is the one this screen must never get wrong: a saved
 * secret does not come back.
 */

const KEYCHAIN = { available: true, backend: "gnome_libsecret", weak: false, warning: null };

const GITHUB: McpServerView = {
  id: "019fb8c6-0000-7000-8000-0000000000a1",
  name: "github",
  description: "reads and opens issues on your GitHub repositories",
  config: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  envNames: ["GITHUB_TOKEN"],
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  connector: null,
  secretsSet: [],
};

/** A remote server that says how it authenticates, rather than only what to send (EO-117). */
const LINEAR: McpServerView = {
  id: "019fb8c6-0000-7000-8000-0000000000a2",
  name: "linear",
  description: "",
  config: { transport: "http", url: "https://mcp.linear.app/mcp", headers: {}, auth: { kind: "bearer", tokenEnvName: "LINEAR_TOKEN" } },
  envNames: ["LINEAR_TOKEN"],
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  connector: null,
  secretsSet: ["LINEAR_TOKEN"],
};

const PLAYBOOK: SkillListEntry = {
  id: "019fb8c6-0000-7000-8000-0000000000b1",
  slug: "pr-review",
  name: "PR review",
  description: "How this house reviews a pull request.",
  body: "Read the diff before you judge it.",
  files: [],
  disableModelInvocation: false,
  enabled: true,
  scope: { kind: "global" },
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null, createdBy: "person", locked: false,
  usage: { runsDelivered: 0, runsLoaded: 0, lastLoadedAt: null, deliveriesSinceLoad: 0 },
  state: "active",
  archive: null,
};

const REVIEWER = { id: "019fb8c6-0000-7000-8000-0000000000c1", name: "Reviewer", role: "reviewer", provider: "claude", model: null, enabled: true, archivedAt: null };

type Envelope = { ok: true; data: unknown } | { ok: false; error: { message: string } };

const DEFAULTS: Record<string, unknown> = {
  "mcpServers:list": { servers: [], keychain: KEYCHAIN },
  "skills:list": { skills: [] },
  "agents:list": { agents: [] },
  "agentAttachments:list": { attachments: [] },
  // The developer pack's vocabulary, so the sentences that name the thing in flight say "ticket".
  "registry:get": toRegistryView(developerRegistry()),
};

/** The channels this screen speaks, plus whatever a case wants to answer differently. */
function mockIpc(responses: Record<string, Envelope> = {}) {
  const calls: { channel: string; payload: unknown }[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    return responses[channel] ?? { ok: true, data: DEFAULTS[channel] ?? {} };
  }) as never;
  return calls;
}

function payloadOf(calls: { channel: string; payload: unknown }[], channel: string): unknown {
  return calls.find((call) => call.channel === channel)?.payload;
}

function renderIn(children: React.ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/agent-tools"]}>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the agent tools catalogue", () => {
  /**
   * The name, which is the acceptance criterion rather than a detail.
   *
   * Settings has a section called "MCP server" that means the opposite
   * thing — EO serving its tools outwards — so this screen has to say
   * which of the two it is where somebody who took a wrong turn is
   * standing.
   */
  it("says it is not the MCP section in Settings", async () => {
    mockIpc();
    renderIn(<AgentTools />);

    expect(await screen.findByRole("heading", { name: "Agent tools" })).toBeInTheDocument();
    const note = screen.getByText(/That one points the other way/);
    expect(note).toHaveTextContent(/^This is not Settings → MCP server\./);
    expect(note).toHaveTextContent("it lets another program drive EO");
    expect(note).toHaveTextContent("what EO hands to the agents it dispatches");
    // And it goes there: the section is this machine's, which a desktop is.
    expect(within(note).getByRole("link", { name: "Settings → MCP server" })).toHaveAttribute("href", "/settings?section=mcp");
  });

  it("creates a server from what was typed, one list entry per line", async () => {
    const calls = mockIpc({ "mcpServers:save": { ok: true, data: { saved: true, server: GITHUB, problem: null } } });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("button", { name: "New server" }));
    fireEvent.change(screen.getByLabelText(/^Name \(/), { target: { value: "github" } });
    fireEvent.change(screen.getByLabelText(/^Command/), { target: { value: "npx" } });
    fireEvent.change(screen.getByLabelText(/^Arguments/), { target: { value: "-y\n@modelcontextprotocol/server-github\n" } });
    fireEvent.change(screen.getByLabelText(/^Environment variables/), { target: { value: "GITHUB_TOKEN" } });
    fireEvent.click(screen.getByRole("button", { name: "Create server" }));

    await waitFor(() => expect(payloadOf(calls, "mcpServers:save")).toBeDefined());
    expect(payloadOf(calls, "mcpServers:save")).toEqual({
      name: "github",
      // Nothing typed into "What it does", which is an empty
      // description rather than an absent one: this form holds the whole
      // of it, so an empty box is somebody saying nothing (EO-314).
      description: "",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      url: null,
      headers: {},
      envNames: ["GITHUB_TOKEN"],
      // `enabled` is deliberately absent: it travels on its own channel,
      // so a save cannot turn a server somebody switched off back on.
    });
  });

  /**
   * The kind, set on the screen rather than only in the database
   * (EO-117).
   *
   * The field exists so a server can say *how* it authenticates instead
   * of only what to send. If it could not be set here it would be one
   * only SQLite could answer — which is what `agents.config` was before
   * the agent editor, and what made two settings real in name only.
   */
  /**
   * What a server does, in the person's words (EO-314, ARCHITECTURE.md, "A connector is an MCP
   * server with a setup flow").
   *
   * EO cannot write this and a tool id cannot either — and it is what
   * the pack import gate shows as a capability, one line per server,
   * instead of a list of `mcp__*` names nobody can weigh. So the form
   * asks for it and the list shows it.
   */
  it("takes a description and shows it beside the server", async () => {
    const calls = mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [GITHUB], keychain: KEYCHAIN } },
      "mcpServers:save": { ok: true, data: { saved: true, server: GITHUB, problem: null } },
    });
    renderIn(<AgentTools />);

    // The one already here says what it reaches, before it says what it is.
    expect(await screen.findByText("reads and opens issues on your GitHub repositories")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New server" }));
    fireEvent.change(screen.getByLabelText(/^Name \(/), { target: { value: "slack" } });
    fireEvent.change(screen.getByLabelText(/^What it does/), { target: { value: "reads your Slack channels" } });
    fireEvent.change(screen.getByLabelText(/^Command/), { target: { value: "slack-mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Create server" }));

    await waitFor(() => expect(payloadOf(calls, "mcpServers:save")).toBeDefined());
    expect(payloadOf(calls, "mcpServers:save")).toMatchObject({ name: "slack", description: "reads your Slack channels" });
  });

  it("creates a bearer server that names the variable holding its token", async () => {
    const calls = mockIpc({ "mcpServers:save": { ok: true, data: { saved: true, server: LINEAR, problem: null } } });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("button", { name: "New server" }));
    fireEvent.change(screen.getByLabelText(/^Name \(/), { target: { value: "linear" } });
    fireEvent.change(screen.getByLabelText("Transport"), { target: { value: "http" } });
    fireEvent.change(screen.getByLabelText(/^URL/), { target: { value: "https://mcp.linear.app/mcp" } });
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "bearer" } });
    fireEvent.change(screen.getByLabelText(/^Token variable/), { target: { value: "LINEAR_TOKEN" } });
    fireEvent.click(screen.getByRole("button", { name: "Create server" }));

    await waitFor(() => expect(payloadOf(calls, "mcpServers:save")).toBeDefined());
    expect(payloadOf(calls, "mcpServers:save")).toEqual({
      name: "linear",
      description: "",
      transport: "http",
      command: null,
      args: [],
      url: "https://mcp.linear.app/mcp",
      headers: {},
      authKind: "bearer",
      // The name, and nothing that could be a token. The value is typed
      // into the keychain row once the server exists.
      bearerTokenEnvName: "LINEAR_TOKEN",
      envNames: [],
    });
  });

  /**
   * Changing the kind, and the one thing a bearer server must show: the
   * variable's name, never its value.
   */
  it("changes a server's authentication kind, showing the variable's name and not its value", async () => {
    const calls = mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [LINEAR], keychain: KEYCHAIN } },
      "mcpServers:save": { ok: true, data: { saved: true, server: LINEAR, problem: null } },
    });
    renderIn(<AgentTools />);

    // On the row, before anything is opened: which variable this server's
    // token is in, said outright.
    expect(await screen.findByText("bearer ${LINEAR_TOKEN}")).toBeInTheDocument();
    // The value is not on this screen and cannot be — no channel hands
    // one back. What the row says about it is whether it is set at all.
    expect(screen.getByLabelText("Value for LINEAR_TOKEN on linear")).toHaveValue("");
    expect(screen.getByText("Set")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByLabelText("Server editor");
    expect(within(editor).getByLabelText("Authentication")).toHaveValue("bearer");
    expect(within(editor).getByLabelText(/^Token variable/)).toHaveValue("LINEAR_TOKEN");

    fireEvent.change(within(editor).getByLabelText("Authentication"), { target: { value: "header" } });
    // The token variable field goes with the kind that gave it meaning.
    expect(within(editor).queryByLabelText(/^Token variable/)).toBeNull();
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(payloadOf(calls, "mcpServers:save")).toBeDefined());
    expect(payloadOf(calls, "mcpServers:save")).toMatchObject({ id: LINEAR.id, authKind: "header", bearerTokenEnvName: null });
  });

  it("creates a skill, leaving the slug for the main process to decide", async () => {
    const calls = mockIpc({ "skills:save": { ok: true, data: { saved: true, skill: PLAYBOOK, problem: null } } });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("tab", { name: /^Skills\s*0$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
    fireEvent.change(screen.getByLabelText(/^Name \(/), { target: { value: "PR review" } });
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: "How this house reviews a pull request." } });
    fireEvent.change(screen.getByLabelText(/^Body/), { target: { value: "Read the diff before you judge it." } });
    fireEvent.click(screen.getByRole("button", { name: "Add a supporting file" }));
    fireEvent.change(screen.getByLabelText("Path for supporting file 1"), { target: { value: "checklist.md" } });
    fireEvent.change(screen.getByLabelText("Contents of supporting file 1"), { target: { value: "- [ ] Read it all" } });
    fireEvent.click(screen.getByRole("button", { name: "Create skill" }));

    await waitFor(() => expect(payloadOf(calls, "skills:save")).toBeDefined());
    expect(payloadOf(calls, "skills:save")).toEqual({
      // Null, not "": absent means "decide one for me", and an empty
      // string would be a slug nobody can invoke.
      slug: null,
      name: "PR review",
      description: "How this house reviews a pull request.",
      body: "Read the diff before you judge it.",
      files: [{ path: "checklist.md", content: "- [ ] Read it all" }],
      disableModelInvocation: false,
      scope: { kind: "global" },
    });
  });

  /** A skill's body holding a value that only exists on this machine (EO-450): named by line as it is typed, and saved anyway. */
  it("names a machine-specific value in the body as it is typed, and creates the skill anyway", async () => {
    const calls = mockIpc({ "skills:save": { ok: true, data: { saved: true, skill: PLAYBOOK, problem: null } } });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("tab", { name: /^Skills\s*0$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
    fireEvent.change(screen.getByLabelText(/^Name \(/), { target: { value: "Deploy" } });
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: "How we deploy." } });
    expect(screen.queryByRole("note", { name: "Machine-specific values" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Body/), { target: { value: "# Deploy\nRun ~/bin/deploy.sh first." } });

    expect(screen.getByRole("note", { name: "Machine-specific values" })).toHaveTextContent("skill body line 2: ~/bin/deploy.sh");

    fireEvent.click(screen.getByRole("button", { name: "Create skill" }));
    await waitFor(() => expect(payloadOf(calls, "skills:save")).toBeDefined());
    expect(payloadOf(calls, "skills:save")).toMatchObject({ body: "# Deploy\nRun ~/bin/deploy.sh first." });
  });

  /**
   * Editing loads what is stored back into the form, and saves in place.
   *
   * The lists are the half worth asserting: they are held as text, one
   * entry per line, so a round trip that lost `args` or turned two
   * arguments into one would be a command that no longer runs.
   */
  it("edits a server in place, round-tripping its lists", async () => {
    const calls = mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [GITHUB], keychain: KEYCHAIN } },
      "mcpServers:save": { ok: true, data: { saved: true, server: GITHUB, problem: null } },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByLabelText("Server editor");
    expect(within(editor).getByLabelText(/^Command/)).toHaveValue("npx");
    expect(within(editor).getByLabelText(/^Arguments/)).toHaveValue("-y\n@modelcontextprotocol/server-github");
    expect(within(editor).getByLabelText(/^Environment variables/)).toHaveValue("GITHUB_TOKEN");

    fireEvent.change(within(editor).getByLabelText(/^Command/), { target: { value: "npx-2" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(payloadOf(calls, "mcpServers:save")).toBeDefined());
    expect(payloadOf(calls, "mcpServers:save")).toEqual({
      id: GITHUB.id,
      name: "github",
      // Round-tripped like the lists: an edit that dropped it would
      // silently delete the line the pack import gate shows.
      description: "reads and opens issues on your GitHub repositories",
      transport: "stdio",
      command: "npx-2",
      args: ["-y", "@modelcontextprotocol/server-github"],
      url: null,
      headers: {},
      envNames: ["GITHUB_TOKEN"],
    });
  });

  /**
   * A skill's scope (EO-470): set on a new skill, shown on its row, and
   * changed on an edit — every project and every workspace offered,
   * whichever project the window is on.
   */
  it("sets a new skill's scope to a project, says so on the row, and moves it to a workspace", async () => {
    const SHOP = { id: "019fb8c6-0000-7000-8000-0000000000d1", name: "Shop", keyPrefix: "SHOP", archivedAt: null };
    const API = { id: "019fb8c6-0000-7000-8000-0000000000e1", label: "shop-api", projectId: SHOP.id };
    const scoped = { ...PLAYBOOK, scope: { kind: "project" as const, projectId: SHOP.id } };
    const calls = mockIpc({
      "projects:list": { ok: true, data: { projects: [SHOP], activeProjectId: SHOP.id } },
      "workspaces:list": { ok: true, data: { workspaces: [API] } },
      "skills:save": { ok: true, data: { saved: true, skill: scoped, problem: null } },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("tab", { name: /^Skills\s*0$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
    fireEvent.change(screen.getByLabelText(/^Name \(/), { target: { value: "PR review" } });
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: "How this house reviews a pull request." } });
    fireEvent.change(screen.getByLabelText(/^Body/), { target: { value: "Read the diff before you judge it." } });
    const picker = screen.getByLabelText("Scope");
    expect(picker).toHaveValue("global");
    await waitFor(() => expect(within(picker).getByRole("option", { name: "shop-api (Shop)" })).toBeInTheDocument());
    fireEvent.change(picker, { target: { value: `project:${SHOP.id}` } });
    fireEvent.click(screen.getByRole("button", { name: "Create skill" }));

    await waitFor(() => expect(payloadOf(calls, "skills:save")).toBeDefined());
    expect(payloadOf(calls, "skills:save")).toMatchObject({ name: "PR review", scope: { kind: "project", projectId: SHOP.id } });
  });

  it("changes a scoped skill's scope on an edit", async () => {
    const SHOP = { id: "019fb8c6-0000-7000-8000-0000000000d1", name: "Shop", keyPrefix: "SHOP", archivedAt: null };
    const API = { id: "019fb8c6-0000-7000-8000-0000000000e1", label: "shop-api", projectId: SHOP.id };
    const scoped = { ...PLAYBOOK, scope: { kind: "project" as const, projectId: SHOP.id } };
    const calls = mockIpc({
      "projects:list": { ok: true, data: { projects: [SHOP], activeProjectId: SHOP.id } },
      "workspaces:list": { ok: true, data: { workspaces: [API] } },
      "skills:list": { ok: true, data: { skills: [scoped] } },
      "skills:save": { ok: true, data: { saved: true, skill: scoped, problem: null } },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("tab", { name: /^Skills\s*1$/ }));
    expect(await screen.findByText("Runs on Shop")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByLabelText("Skill editor");
    expect(within(editor).getByLabelText("Scope")).toHaveValue(`project:${SHOP.id}`);
    fireEvent.change(within(editor).getByLabelText("Scope"), { target: { value: `workspace:${API.id}` } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(payloadOf(calls, "skills:save")).toBeDefined());
    expect(payloadOf(calls, "skills:save")).toMatchObject({ id: PLAYBOOK.id, scope: { kind: "workspace", workspaceId: API.id } });
  });

  it("edits a skill in place, keeping its slug and its supporting files", async () => {
    const withFile = { ...PLAYBOOK, files: [{ path: "checklist.md", content: "- [ ] Read it all" }] };
    const calls = mockIpc({
      "skills:list": { ok: true, data: { skills: [withFile] } },
      "skills:save": { ok: true, data: { saved: true, skill: withFile, problem: null } },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("tab", { name: /^Skills\s*1$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByLabelText("Skill editor");
    expect(within(editor).getByLabelText("Contents of supporting file 1")).toHaveValue("- [ ] Read it all");

    fireEvent.change(within(editor).getByLabelText(/^Body/), { target: { value: "Read the whole diff." } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(payloadOf(calls, "skills:save")).toBeDefined());
    expect(payloadOf(calls, "skills:save")).toEqual({
      id: PLAYBOOK.id,
      // The slug it already has, sent back as itself — an edit does not
      // get to reallocate the one name a model can invoke.
      slug: "pr-review",
      name: "PR review",
      description: "How this house reviews a pull request.",
      body: "Read the whole diff.",
      files: [{ path: "checklist.md", content: "- [ ] Read it all" }],
      disableModelInvocation: false,
      scope: { kind: "global" },
    });
  });

  /** Ownership, the lock and the history (EO-714). */
  it("shows who wrote a skill and whether it is locked, and locks it with the switch", async () => {
    const agents = { ...PLAYBOOK, createdBy: "agent" as const };
    const calls = mockIpc({
      "skills:list": { ok: true, data: { skills: [agents] } },
      "skills:setLocked": { ok: true, data: { skill: { ...agents, locked: true }, problem: null } },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("tab", { name: /^Skills\s*1$/ }));
    const card = await screen.findByRole("region", { name: "PR review" });
    expect(card).toHaveTextContent("Written by an agent");
    const lock = within(card).getByRole("switch", { name: "Locked" });
    expect(lock).toHaveAttribute("aria-checked", "false");

    fireEvent.click(lock);

    await waitFor(() => expect(payloadOf(calls, "skills:setLocked")).toEqual({ id: PLAYBOOK.id, locked: true }));
  });

  /** Usage, counted from the runs' events (EO-715), on a person's skill as on an agent's. */
  it("shows how often each skill was delivered and loaded, whoever wrote it", async () => {
    const at = new Date(2026, 0, 5).getTime();
    mockIpc({
      "skills:list": {
        ok: true,
        data: {
          skills: [
            { ...PLAYBOOK, usage: { runsDelivered: 12, runsLoaded: 3, lastLoadedAt: at, deliveriesSinceLoad: 4 } },
            { ...PLAYBOOK, id: "019fb8c6-0000-7000-8000-0000000000b2", slug: "release", name: "Release", createdBy: "agent" },
          ],
        },
      },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("tab", { name: /^Skills\s*2$/ }));
    const person = await screen.findByRole("region", { name: "PR review" });
    expect(person).toHaveTextContent(`Delivered to 12 runs, loaded by 3 runs, last loaded ${new Date(at).toLocaleString()} · 4 runs without a load since`);
    expect(screen.getByRole("region", { name: "Release" })).toHaveTextContent("Not delivered to a run yet");
  });

  /** Where each skill stands (EO-720), beside the numbers that put it there. */
  it("shows each skill's state, active, stale or archived, beside its usage", async () => {
    mockIpc({
      "skills:list": {
        ok: true,
        data: {
          skills: [
            PLAYBOOK,
            { ...PLAYBOOK, id: "019fb8c6-0000-7000-8000-0000000000b2", slug: "release", name: "Release", createdBy: "agent", state: "stale", usage: { runsDelivered: 25, runsLoaded: 0, lastLoadedAt: null, deliveriesSinceLoad: 25 } },
            { ...PLAYBOOK, id: "019fb8c6-0000-7000-8000-0000000000b3", slug: "old", name: "Old", createdBy: "agent", state: "archived", archivedAt: 5, usage: { runsDelivered: 50, runsLoaded: 0, lastLoadedAt: null, deliveriesSinceLoad: 50 } },
          ],
        },
      },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("tab", { name: /^Skills\s*2$/ }));
    const usageRow = (name: string) => within(screen.getByRole("region", { name })).getByText(/Delivered to|Not delivered/).parentElement!;
    await screen.findByRole("region", { name: "PR review" });
    expect(usageRow("PR review")).toHaveTextContent("Active");
    expect(usageRow("Release")).toHaveTextContent("Stale");
    expect(usageRow("Release")).toHaveTextContent("25 runs without a load since");

    fireEvent.click(screen.getByRole("button", { name: "Show archived (1)" }));
    expect(usageRow("Old")).toHaveTextContent("Archived");
  });

  it("lists a skill's history and restores an earlier version", async () => {
    const at = (n: number) => new Date(2026, 0, n).getTime();
    const versions = [
      { id: "v3", skillId: PLAYBOOK.id, action: "archive", description: "Second.", body: "Two.", files: [], author: { kind: "consolidation", consolidationId: "c-1" }, restoredFrom: null, report: null, createdAt: at(3) },
      { id: "v2", skillId: PLAYBOOK.id, action: "edit", description: "Second.", body: "Two.", files: [], author: { kind: "run", runId: "r-1" }, restoredFrom: null, report: null, createdAt: at(2) },
      { id: "v1", skillId: PLAYBOOK.id, action: "create", description: "First.", body: "One.", files: [], author: { kind: "person" }, restoredFrom: null, report: null, createdAt: at(1) },
    ];
    const calls = mockIpc({
      "skills:list": { ok: true, data: { skills: [{ ...PLAYBOOK, locked: true }] } },
      "skills:versions": { ok: true, data: { versions, problem: null } },
      "skills:restoreVersion": { ok: true, data: { skill: PLAYBOOK, problem: null } },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("tab", { name: /^Skills\s*1$/ }));
    expect(await screen.findByText("Written by a person")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Locked" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "History" }));

    const history = await screen.findByRole("region", { name: "History of PR review" });
    await waitFor(() => expect(history).toHaveTextContent("Archived by memory consolidation c-1 — current"));
    expect(history).toHaveTextContent("Edited by run r-1");
    expect(history).toHaveTextContent("Created by a person");
    // Restore on every earlier version, never on the current one.
    const restores = within(history).getAllByRole("button", { name: /^Restore the version from/ });
    expect(restores).toHaveLength(2);

    fireEvent.click(restores[1]!);

    await waitFor(() => expect(payloadOf(calls, "skills:restoreVersion")).toEqual({ id: PLAYBOOK.id, versionId: "v1" }));
  });

  it("shows on a version a consolidation wrote its evidence and diff, and on EO's archive the runs without a load (EO-728)", async () => {
    const at = (n: number) => new Date(2026, 0, n).getTime();
    const versions = [
      { id: "v3", skillId: PLAYBOOK.id, action: "archive", description: "Two.", body: "Two.", files: [], author: { kind: "eo" }, restoredFrom: null, report: { kind: "unused", runsWithoutLoad: 30 }, createdAt: at(3) },
      {
        id: "v2",
        skillId: PLAYBOOK.id,
        action: "edit",
        description: "Two.",
        body: "Two.",
        files: [],
        author: { kind: "consolidation", consolidationId: "c-1" },
        restoredFrom: null,
        report: {
          kind: "consolidation",
          evidence: [{ entryId: "m-1", body: "Run Xvfb before the e2e suite.", itemKey: "SHOP-12" }],
          itemKeys: ["SHOP-12", "SHOP-14"],
          diff: "--- a/pr-review/SKILL.md\n+++ b/pr-review/SKILL.md\n-One.\n+Two.",
        },
        createdAt: at(2),
      },
      { id: "v1", skillId: PLAYBOOK.id, action: "create", description: "One.", body: "One.", files: [], author: { kind: "person" }, restoredFrom: null, report: null, createdAt: at(1) },
    ];
    mockIpc({
      "skills:list": { ok: true, data: { skills: [PLAYBOOK] } },
      "skills:versions": { ok: true, data: { versions, problem: null } },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("tab", { name: /^Skills\s*1$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    const history = await screen.findByRole("region", { name: "History of PR review" });
    await waitFor(() => expect(history).toHaveTextContent("Edited by memory consolidation c-1"));
    expect(history).toHaveTextContent("Archived by EO after 30 runs without a load.");
    const evidence = within(history).getByRole("list", { name: "Evidence" });
    expect(evidence).toHaveTextContent("SHOP-12 · Run Xvfb before the e2e suite.");
    expect(history).toHaveTextContent("Seen on SHOP-12, SHOP-14.");
    expect(within(history).getByLabelText("Diff")).toHaveTextContent("-One. +Two.");
  });

  it("says on an archived skill that EO archived it after N runs without a load, and restores it there (EO-728)", async () => {
    const archived: SkillListEntry = {
      ...PLAYBOOK,
      name: "Old",
      createdBy: "agent",
      archivedAt: 5,
      state: "archived",
      archive: { versionId: "v-archive", author: { kind: "eo" }, runsWithoutLoad: 30 },
    };
    const calls = mockIpc({
      "skills:list": { ok: true, data: { skills: [archived] } },
      "skills:restoreVersion": { ok: true, data: { skill: PLAYBOOK, problem: null } },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("tab", { name: /^Skills/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Show archived (1)" }));
    const card = await screen.findByRole("region", { name: "Old" });
    expect(card).toHaveTextContent("Archived by EO after 30 runs without a load.");
    fireEvent.click(within(card).getByRole("button", { name: "Restore Old" }));
    await waitFor(() => expect(payloadOf(calls, "skills:restoreVersion")).toEqual({ id: archived.id, versionId: "v-archive" }));
  });

  it("attaches a server to an agent from the catalogue", async () => {
    const calls = mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [GITHUB], keychain: KEYCHAIN } },
      "agents:list": { ok: true, data: { agents: [REVIEWER] } },
      "agentAttachments:set": { ok: true, data: { attachments: { agentId: REVIEWER.id, mcpServerIds: [GITHUB.id], skillIds: [] }, problem: null } },
    });
    renderIn(<AgentTools />);

    // Named for the sentence it stands for, because several entries each
    // carry a row of agents and "Reviewer" alone would name all of them.
    const tick = await screen.findByRole("checkbox", { name: "Reviewer gets github" });
    expect(tick).not.toBeChecked();

    fireEvent.click(tick);

    await waitFor(() => expect(payloadOf(calls, "agentAttachments:set")).toBeDefined());
    expect(payloadOf(calls, "agentAttachments:set")).toEqual({ agentId: REVIEWER.id, kind: "mcpServer", id: GITHUB.id, attached: true });
  });

  it("detaches the one it already has", async () => {
    const calls = mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [GITHUB], keychain: KEYCHAIN } },
      "agents:list": { ok: true, data: { agents: [REVIEWER] } },
      "agentAttachments:list": { ok: true, data: { attachments: [{ agentId: REVIEWER.id, mcpServerIds: [GITHUB.id], skillIds: [] }] } },
      "agentAttachments:set": { ok: true, data: { attachments: { agentId: REVIEWER.id, mcpServerIds: [], skillIds: [] }, problem: null } },
    });
    renderIn(<AgentTools />);

    const tick = await screen.findByRole("checkbox", { name: "Reviewer gets github" });
    await waitFor(() => expect(tick).toBeChecked());

    fireEvent.click(tick);

    await waitFor(() => expect(payloadOf(calls, "agentAttachments:set")).toBeDefined());
    expect(payloadOf(calls, "agentAttachments:set")).toEqual({ agentId: REVIEWER.id, kind: "mcpServer", id: GITHUB.id, attached: false });
  });

  it("attaches from the agent's end too", async () => {
    const calls = mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [GITHUB], keychain: KEYCHAIN } },
      "skills:list": { ok: true, data: { skills: [PLAYBOOK] } },
      "agentAttachments:set": { ok: true, data: { attachments: { agentId: REVIEWER.id, mcpServerIds: [], skillIds: [PLAYBOOK.id] }, problem: null } },
    });
    renderIn(<AgentToolPicker agentId={REVIEWER.id} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "PR review" }));

    await waitFor(() => expect(payloadOf(calls, "agentAttachments:set")).toBeDefined());
    expect(payloadOf(calls, "agentAttachments:set")).toEqual({ agentId: REVIEWER.id, kind: "skill", id: PLAYBOOK.id, attached: true });
    // The part a person cannot guess, said where the tick is made.
    expect(screen.getByText(/Applies from the next dispatch/)).toHaveTextContent("starts a fresh conversation on that ticket");
  });

  /**
   * The refusal path, in the shape the contract actually sends it: a
   * successful envelope carrying `problem`.
   *
   * Nothing about an empty command or the reserved name `eo` is
   * programmer error, so none of it throws — and the editor stays open,
   * because the person has a field to fix.
   */
  it("shows a refused save as a message, with the editor still open", async () => {
    const refusal = '"eo" is the name of EO\'s own MCP server, which every agent already has — pick another name.';
    mockIpc({ "mcpServers:save": { ok: true, data: { saved: false, server: null, problem: refusal } } });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("button", { name: "New server" }));
    fireEvent.change(screen.getByLabelText(/^Name \(/), { target: { value: "eo" } });
    fireEvent.change(screen.getByLabelText(/^Command/), { target: { value: "npx" } });
    fireEvent.click(screen.getByRole("button", { name: "Create server" }));

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create server" })).toBeInTheDocument();
  });

  /**
   * And in the other shape: a refused envelope, which `ipcQuery` turns
   * into a rejected promise.
   *
   * This is the one that used to become an unhandled rejection and a
   * control that did nothing and said nothing. A tick that lost a race
   * with a deletion in another window has to end in a sentence too.
   */
  it("shows a rejected envelope as a message rather than throwing", async () => {
    mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [GITHUB], keychain: KEYCHAIN } },
      "agents:list": { ok: true, data: { agents: [REVIEWER] } },
      "agentAttachments:set": { ok: false, error: { message: "That agent no longer exists." } },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Reviewer gets github" }));

    expect(await screen.findByText("That agent no longer exists.")).toBeInTheDocument();
  });

  it("reads a header line it cannot make sense of back as a sentence, without sending it", async () => {
    const calls = mockIpc();
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("button", { name: "New server" }));
    fireEvent.change(screen.getByLabelText(/^Name \(/), { target: { value: "linear" } });
    fireEvent.change(screen.getByLabelText("Transport"), { target: { value: "http" } });
    fireEvent.change(screen.getByLabelText(/^URL/), { target: { value: "https://example.com/mcp" } });
    fireEvent.change(screen.getByLabelText(/^Headers/), { target: { value: "Authorization Bearer x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create server" }));

    expect(await screen.findByText(/line 1 has no colon in it/)).toBeInTheDocument();
    expect(payloadOf(calls, "mcpServers:save")).toBeUndefined();
  });

  /**
   * The one this screen must never get wrong.
   *
   * A value goes in and nothing hands one back unless the person presses
   * Reveal (EO-489, `hooks/useSecretReveal.test.tsx`), which this test
   * never does — so the field is a password box that starts empty,
   * says only whether the name is set, and is emptied the moment the
   * value has been sent. Asserted against the whole document, not
   * against the input: a value echoed into a badge or a heading would be
   * just as leaked.
   */
  it("never renders a saved secret back", async () => {
    const calls = mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [{ ...GITHUB, secretsSet: ["GITHUB_TOKEN"] }], keychain: KEYCHAIN } },
      "mcpServers:setSecret": { ok: true, data: { saved: true, problem: null, keychain: KEYCHAIN } },
    });
    const { container } = renderIn(<AgentTools />);

    const field = (await screen.findByLabelText("Value for GITHUB_TOKEN on github")) as HTMLInputElement;
    expect(field).toHaveAttribute("type", "password");
    expect(field.value).toBe("");
    expect(screen.getByText("Set")).toBeInTheDocument();

    fireEvent.change(field, { target: { value: "ghp_notarealtoken" } });
    fireEvent.click(screen.getByRole("button", { name: "Save GITHUB_TOKEN for github" }));

    await waitFor(() => expect(payloadOf(calls, "mcpServers:setSecret")).toBeDefined());
    await waitFor(() => expect(field.value).toBe(""));
    expect(container.textContent).not.toContain("ghp_notarealtoken");
  });

  it("clears a value that is set", async () => {
    const calls = mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [{ ...GITHUB, secretsSet: ["GITHUB_TOKEN"] }], keychain: KEYCHAIN } },
      "mcpServers:clearSecret": { ok: true, data: { cleared: true } },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("button", { name: "Clear GITHUB_TOKEN for github" }));

    await waitFor(() => expect(payloadOf(calls, "mcpServers:clearSecret")).toBeDefined());
    expect(payloadOf(calls, "mcpServers:clearSecret")).toEqual({ serverId: GITHUB.id, name: "GITHUB_TOKEN" });
  });

  /**
   * A declared name no secret fills and a shared environment variable
   * will (EO-488): the row says where the value is coming from rather
   * than "Not set", below a stored secret and the organisation's, as the
   * spawn asks them.
   */
  it("says a declared name is filled from environment variables when only a variable fills it", async () => {
    const CLOUD: McpServerView = { ...GITHUB, id: "019fb8c6-0000-7000-8000-0000000000a9", name: "cloud", envNames: ["REGION", "OWN", "ORG", "NOTHING"], secretsSet: ["OWN"] };
    mockIpc({
      "mcpServers:list": {
        ok: true,
        data: { servers: [CLOUD], keychain: KEYCHAIN, managedIds: [], organisationSecrets: ["ORG"], environmentVariables: ["REGION", "OWN", "ORG"], unavailable: [] },
      },
    });
    renderIn(<AgentTools />);

    // The row is the field's own list item: the name, its state, the field and its buttons.
    const row = (name: string) => screen.getByLabelText(`Value for ${name} on cloud`).closest("li") as HTMLElement;
    await screen.findByLabelText("Value for REGION on cloud");
    expect(within(row("REGION")).getByText("From environment variables")).toBeInTheDocument();
    expect(within(row("OWN")).getByText("Set")).toBeInTheDocument();
    expect(within(row("ORG")).getByText(ORGANISATION_SECRET_LINE)).toBeInTheDocument();
    expect(within(row("NOTHING")).getByText("Not set")).toBeInTheDocument();
    expect(screen.getAllByText("From environment variables")).toHaveLength(1);
  });

  /**
   * A machine that cannot hold a secret says so where one would be
   * typed, and refuses to take it.
   *
   * On Linux `safeStorage` reports encryption available while having
   * fallen back to a key compiled into Chromium. EO-104 made that a
   * refusal in the main process; the screen's job is not to invite the
   * paste in the first place.
   */
  it("says why a value cannot be stored, and does not offer to store it", async () => {
    const warning = "This machine's keychain is basic_text, which is encryption in name only. EO will not store a token in it.";
    mockIpc({
      "mcpServers:list": {
        ok: true,
        data: { servers: [GITHUB], keychain: { available: true, backend: "basic_text", weak: true, warning } },
      },
    });
    renderIn(<AgentTools />);

    expect(await screen.findByText(warning)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Value for GITHUB_TOKEN on github"), { target: { value: "ghp_notarealtoken" } });
    expect(screen.getByRole("button", { name: "Save GITHUB_TOKEN for github" })).toBeDisabled();
  });

  /**
   * A refused row action reports against the row, not against whatever
   * happens to be open.
   *
   * The two refusals are about different things — "that server no longer
   * exists" is not a note about the field somebody is typing in — and
   * sharing one slot put the first inside the editor, beside a field it
   * said nothing about.
   */
  it("keeps a refused archive out of the editor", async () => {
    mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [GITHUB], keychain: KEYCHAIN } },
      "mcpServers:archive": { ok: true, data: { archived: false, problem: "That MCP server no longer exists." } },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("button", { name: "New server" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await screen.findByText("That MCP server no longer exists.");
    const editor = screen.getByLabelText("Server editor");
    expect(within(editor).getByRole("button", { name: "Create server" })).toBeInTheDocument();
    // Above the list, where the row it is about is — not inside the panel
    // holding the draft, and not having disturbed what was typed there.
    expect(within(editor).queryByText("That MCP server no longer exists.")).not.toBeInTheDocument();
  });

  it("enables, disables and archives an entry", async () => {
    const calls = mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [GITHUB], keychain: KEYCHAIN } },
      "mcpServers:setEnabled": { ok: true, data: { server: { ...GITHUB, enabled: false }, problem: null } },
      "mcpServers:archive": { ok: true, data: { archived: true, problem: null } },
    });
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
    await waitFor(() => expect(payloadOf(calls, "mcpServers:setEnabled")).toEqual({ id: GITHUB.id, enabled: false }));

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(payloadOf(calls, "mcpServers:archive")).toEqual({ id: GITHUB.id }));
  });

  it("holds a server's switch as pending until the list is read again, and that row's alone (EO-562)", async () => {
    let enabled = true;
    let land: (value: unknown) => void = () => {};
    const calls = mockIpc();
    const answered = window.eo.ipc.invoke;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "mcpServers:list") {
        calls.push({ channel, payload });
        return { ok: true, data: { servers: [{ ...GITHUB, enabled }, LINEAR], keychain: KEYCHAIN } };
      }
      if (channel === "mcpServers:setEnabled") {
        calls.push({ channel, payload });
        return new Promise<never>((resolve) => (land = resolve as (value: unknown) => void));
      }
      return answered(channel as never, payload as never);
    }) as never;
    renderIn(<AgentTools />);

    const github = await screen.findByRole("region", { name: GITHUB.name });
    const linear = screen.getByRole("region", { name: LINEAR.name });
    const toggle = within(github).getByRole("button", { name: "Disable" });
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    const pending = await within(github).findByRole("button", { name: "Disabling…" });
    expect(pending).toBeDisabled();
    expect(within(github).getByRole("button", { name: "Archive" })).toBeDisabled();
    expect(within(linear).getByRole("button", { name: /^(Enable|Disable)$/ })).toBeEnabled();
    expect(calls.filter((call) => call.channel === "mcpServers:setEnabled")).toHaveLength(1);

    enabled = false;
    await act(async () => land({ ok: true, data: { server: { ...GITHUB, enabled: false }, problem: null } }));
    expect(await within(github).findByRole("button", { name: "Enable" })).toBeEnabled();
    expect(within(github).getByText("Disabled")).toBeInTheDocument();
  });

  it("lets a refused switch go back to what it was, saying why (EO-562)", async () => {
    let refuse: (value: unknown) => void = () => {};
    mockIpc({ "mcpServers:list": { ok: true, data: { servers: [GITHUB], keychain: KEYCHAIN } } });
    const answered = window.eo.ipc.invoke;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) =>
      channel === "mcpServers:setEnabled" ? new Promise<never>((resolve) => (refuse = resolve as (value: unknown) => void)) : answered(channel as never, payload as never),
    ) as never;
    renderIn(<AgentTools />);

    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
    expect(await screen.findByRole("button", { name: "Disabling…" })).toBeDisabled();
    await act(async () => refuse({ ok: false, error: { message: "The keychain is locked." } }));

    expect(await screen.findByText("The keychain is locked.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable" })).toBeEnabled();
  });

  /**
   * Archived rather than deleted (invariant #3), and still reachable
   * from the agent that holds it.
   *
   * The reason EO-106 archives instead of deleting is that an agent goes
   * on pointing at something a person can read. That is only true if the
   * screen offers it — an archived entry an agent still has must be
   * visible there to be taken off, even though the catalogue hides it.
   */
  it("keeps an archived entry the agent still holds on the agent's list", async () => {
    mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [{ ...GITHUB, archivedAt: 5 }], keychain: KEYCHAIN } },
      "agentAttachments:list": { ok: true, data: { attachments: [{ agentId: REVIEWER.id, mcpServerIds: [GITHUB.id], skillIds: [] }] } },
    });
    renderIn(<AgentToolPicker agentId={REVIEWER.id} />);

    const tick = await screen.findByRole("checkbox", { name: "github" });
    await waitFor(() => expect(tick).toBeChecked());
    expect(screen.getByText("archived")).toBeInTheDocument();
  });
});

/**
 * Which catalogue is on screen (EO-192).
 *
 * Servers and skills are two different things an agent can be given, and
 * "add this one" means a different act on each — so the tab is a view
 * parameter rather than a detail of how the page is laid out.
 */
describe("what the agent tools screen publishes", () => {
  function renderTools(responses: Record<string, Envelope> = {}) {
    const calls = mockIpc(responses);
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/agent-tools"]}>
          {/* As `App.tsx` mounts it. */}
          <ViewPublisher>
            <AgentTools />
          </ViewPublisher>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return calls;
  }

  function lastFacets(calls: { channel: string; payload: unknown }[]): Record<string, string> {
    const publishes = calls.filter((call) => call.channel === "view:publish");
    return ((publishes.at(-1)?.payload as { filter?: { facets?: Record<string, string> } } | undefined)?.filter?.facets) ?? {};
  }

  it("publishes the tab it opens on", async () => {
    const calls = renderTools();
    await screen.findByRole("tab", { name: /MCP servers/ });

    await waitFor(() => expect(lastFacets(calls)).toEqual({ tab: "servers", archived: "false" }));
  });

  it("republishes when the tab changes", async () => {
    const calls = renderTools();
    await screen.findByRole("tab", { name: /MCP servers/ });

    fireEvent.click(screen.getByRole("tab", { name: /Skills/ }));

    await waitFor(() => expect(lastFacets(calls)).toEqual({ tab: "skills", archived: "false" }));
  });

  /**
   * *Show archived* decides which rows are drawn, and each catalogue
   * keeps its own answer (EO-192).
   *
   * Published from the catalogue rather than lifted into the tabs,
   * because the button is beside the list it reveals — and merged with
   * the tab by `ViewPublisher`, so the snapshot carries both. Without it
   * a later `view_current` cannot tell a live-only list from one showing
   * archived servers.
   */
  it("publishes Show archived on the servers tab, and again when it is toggled", async () => {
    const calls = renderTools({
      "mcpServers:list": { ok: true, data: { servers: [{ ...LINEAR, archivedAt: 1 }], keychain: KEYCHAIN } },
    });
    await screen.findByRole("tab", { name: /MCP servers/ });
    await waitFor(() => expect(lastFacets(calls)).toEqual({ tab: "servers", archived: "false" }));

    fireEvent.click(await screen.findByRole("button", { name: /Show archived/ }));

    await waitFor(() => expect(lastFacets(calls)).toEqual({ tab: "servers", archived: "true" }));
  });

  it("publishes Show archived on the skills tab too, kept apart from the servers tab's", async () => {
    const calls = renderTools({
      "skills:list": { ok: true, data: { skills: [{ ...PLAYBOOK, archivedAt: 1 }] } },
    });
    await screen.findByRole("tab", { name: /MCP servers/ });

    fireEvent.click(screen.getByRole("tab", { name: /Skills/ }));
    await waitFor(() => expect(lastFacets(calls)).toEqual({ tab: "skills", archived: "false" }));

    fireEvent.click(await screen.findByRole("button", { name: /Show archived/ }));
    await waitFor(() => expect(lastFacets(calls)).toEqual({ tab: "skills", archived: "true" }));

    // Each catalogue keeps its own answer, so walking back to servers
    // reports that tab's setting rather than this one's.
    fireEvent.click(screen.getByRole("tab", { name: /MCP servers/ }));
    await waitFor(() => expect(lastFacets(calls)).toEqual({ tab: "servers", archived: "false" }));
  });
});

/**
 * A server the organisation published, on a desktop (EO-328, ARCHITECTURE.md, "Policy",
 * review).
 *
 * The screen half of "published definitions are read-only": Edit is
 * greyed with the reason beside it rather than offered and then undone
 * by the next sync, and Archive is not offered at all. Disable stays,
 * which is the same split the design makes for a published agent — the
 * definition is the organisation's, and whether it runs *here* is the
 * person's.
 *
 * The command path refuses it too (`ipc/mcpServerCommands.test.ts`), and
 * that is the half that makes it a rule; this is the half that stops
 * anybody meeting it.
 */
describe("a published MCP server", () => {
  const listed = { servers: [GITHUB], keychain: KEYCHAIN, managedIds: [GITHUB.id], organisationSecrets: [], unavailable: [] };

  it("greys Edit, says why, and offers no Archive", async () => {
    mockIpc({ "mcpServers:list": { ok: true, data: listed } });
    renderIn(
      <ViewPublisher>
        <AgentTools />
      </ViewPublisher>,
    );

    await screen.findByText("github");
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.getByText(/published by your organisation/)).toBeInTheDocument();
    expect(screen.getByText("from your organisation")).toBeInTheDocument();
    // The local half is still offered.
    expect(screen.getByRole("button", { name: "Disable" })).toBeEnabled();
  });

  it("says which published server this machine has not got, where the row would have been", async () => {
    // Above the list rather than beside a row, because there is no row —
    // that is the whole problem. Without this the catalogue shows the
    // person's own `github`, says nothing about their organisation's,
    // and the first evidence is an agent reporting a tool it was never
    // given (invariant 12: an absence is never left to be discovered by
    // an agent).
    const problem =
      'Your organisation publishes an MCP server called "github" and this machine has not installed it, because a server of your own already has that name. Rename yours and it arrives on the next sync.';
    mockIpc({
      "mcpServers:list": { ok: true, data: { ...listed, managedIds: [], unavailable: [{ name: "github", problem }] } },
    });
    renderIn(
      <ViewPublisher>
        <AgentTools />
      </ViewPublisher>,
    );

    expect(await screen.findByText(problem)).toBeInTheDocument();
  });

  it("says nothing where the organisation's servers all arrived", async () => {
    mockIpc({ "mcpServers:list": { ok: true, data: listed } });
    renderIn(
      <ViewPublisher>
        <AgentTools />
      </ViewPublisher>,
    );

    await screen.findByText("github");
    expect(screen.queryByText(/has not installed it/)).not.toBeInTheDocument();
  });

  it("leaves a server of this machine's own fully editable", async () => {
    mockIpc({ "mcpServers:list": { ok: true, data: { ...listed, managedIds: [] } } });
    renderIn(
      <ViewPublisher>
        <AgentTools />
      </ViewPublisher>,
    );

    await screen.findByText("github");
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.queryByText(/published by your organisation/)).not.toBeInTheDocument();
  });
});

/** What the chat layout's drawing adds or must not lose. */
describe("the chat drawing", () => {
  afterEach(() => setBridge(undefined));

  it("says the next-dispatch note in the project's own word, not the developer pack's", async () => {
    mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [GITHUB], keychain: KEYCHAIN } },
      // No pack's vocabulary: the core's own word.
      "registry:get": { ok: true, data: {} },
    });
    renderIn(<AgentTools />);

    await screen.findByText("github");
    const note = await screen.findByText(/Applies from the next dispatch/);
    expect(note).toHaveTextContent("An item already in flight");
    expect(note).not.toHaveTextContent(/ticket/i);
  });

  it("fences the skills while the organisation manages the packs section, and leaves the servers alone", async () => {
    mockIpc({
      "mcpServers:list": { ok: true, data: { servers: [GITHUB], keychain: KEYCHAIN } },
      "skills:list": { ok: true, data: { skills: [PLAYBOOK] } },
      "sections:list": { ok: true, data: { published: [], locked: ["packs"] } },
    });
    renderIn(<AgentTools />);

    expect(await screen.findByRole("button", { name: "Edit" })).toBeEnabled();
    fireEvent.click(screen.getByRole("tab", { name: /^Skills/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "New skill" })).toBeDisabled();
  });

  it("opens an edit in place of its row", async () => {
    mockIpc({ "mcpServers:list": { ok: true, data: { servers: [GITHUB, LINEAR], keychain: KEYCHAIN } } });
    renderIn(<AgentTools />);

    const linear = await screen.findByRole("region", { name: "linear" });
    fireEvent.click(within(linear).getByRole("button", { name: "Edit" }));

    expect(screen.queryByRole("region", { name: "linear" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Server editor" })).toHaveTextContent("Edit linear");
    expect(screen.getByRole("region", { name: "github" })).toBeInTheDocument();
  });

  it("names Settings without linking to it where this machine has no such section", async () => {
    mockIpc();
    setBridge({
      invoke: ((channel: string, payload: unknown) => window.eo.ipc.invoke(channel as never, payload as never)) as never,
      machineAvailable: false,
      subscribe: () => () => {},
      subscribeRefetch: () => () => {},
    });
    renderIn(<AgentTools />);

    const note = await screen.findByText(/That one points the other way/);
    expect(note).toHaveTextContent("This is not Settings → MCP server.");
    expect(within(note).queryByRole("link")).not.toBeInTheDocument();
  });
});
