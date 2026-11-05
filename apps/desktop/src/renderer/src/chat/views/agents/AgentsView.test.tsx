import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerRegistry, isBuiltinRole, NO_POLICY, NOT_ALLOWED_BY_YOUR_ORGANISATION, SECTION_LOCK_TEXT, toRegistryView } from "@eo/core";
import type { ProviderCapabilities, ProviderModel, RuntimeStatusView } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { setBridge } from "../../../ipc/bridge";
import { ViewPublisher } from "../../../shared/view/ViewPublisher";
import { AgentsView } from "./AgentsView";

/**
 * The chat layout's Agents view, held to what the classic screen's tests
 * (`agents/Agents.test.tsx`, `ManagedAgents.test.tsx`) hold it to: the
 * same channels, the same payloads, the same publications. Only the
 * drawing is different.
 */

const registry = developerRegistry();
const registryView = toRegistryView(registry);

const CLAUDE_MODELS: ProviderModel[] = [
  { value: "claude-opus-5", label: "Opus 5", supportsEffort: true, effortLevels: ["low", "high"] },
  { value: "claude-haiku-4-5", label: "Haiku 4.5", supportsEffort: false, effortLevels: [] },
];

function capabilities(provider: string): ProviderCapabilities {
  const empty = { models: [], modelsAreLive: false, reasoningEfforts: [] };
  if (provider === "claude") return { ...empty, provider, modelsAreLive: true };
  if (provider === "codex") {
    return {
      ...empty,
      provider,
      models: [{ value: "gpt-5.1-codex", label: "GPT-5.1 Codex", supportsEffort: true, effortLevels: ["low", "high", "xhigh"] }],
      reasoningEfforts: ["low", "high", "xhigh"],
    };
  }
  return { ...empty, provider };
}

const SIGNED_IN: RuntimeStatusView["auth"] = { state: "signed_in", method: "ChatGPT", kind: "subscription", storedKey: false, account: null, problem: null };
const SIGNED_OUT: RuntimeStatusView["auth"] = { state: "signed_out", method: null, kind: "unknown", storedKey: false, account: null, problem: null };
const STORED_KEY: RuntimeStatusView["auth"] = { state: "signed_in", method: "API key", kind: "api_key", storedKey: true, account: null, problem: null };

const ABSENT: RuntimeStatusView = {
  id: "claude",
  label: "Claude Code",
  publisher: "Anthropic PBC",
  termsUrl: "https://code.claude.com/docs/en/legal-and-compliance",
  source: "absent",
  path: null,
  version: null,
  packageName: "@anthropic-ai/claude-agent-sdk-linux-x64",
  packageVersion: "0.3.227",
  state: "needs_consent",
  auth: { state: "unknown", method: null, kind: "unknown", storedKey: false, account: null, problem: "EO has nothing to ask." },
};

const CODEX: RuntimeStatusView = {
  id: "codex",
  label: "Codex",
  publisher: "OpenAI",
  termsUrl: "https://github.com/openai/codex/blob/main/LICENSE",
  source: "cache",
  path: "/home/x/.config/EO/runtimes/codex@0.147.0/codex",
  version: "0.147.0",
  packageName: "@openai/codex",
  packageVersion: "0.147.0-linux-x64",
  state: "ready",
  automaticUpdates: true,
  auth: SIGNED_IN,
  components: [{ id: "codex", label: "Codex CLI", version: "0.147.0-linux-x64", installed: true, packageName: "@openai/codex" }],
};

function agent(overrides: Record<string, unknown> = {}) {
  const role = (overrides["role"] as string | undefined) ?? "implementer";
  return {
    id: "a1",
    name: "Implementer",
    role,
    provider: "claude",
    model: null,
    enabled: true,
    instructions: "",
    defaultInstructions: null,
    builtin: isBuiltinRole(registry, role),
    config: {},
    archivedAt: null,
    pipelineCount: 1,
    ...overrides,
  };
}

interface Options {
  agents?: unknown[];
  modelProblem?: string | null;
  runtime?: (provider: string, executablePath: string | null) => RuntimeStatusView | null;
  servers?: unknown[];
  allowedBackends?: string[] | null;
  locked?: boolean;
  impact?: unknown;
  removeProblem?: string | null;
  handle?: (channel: string, payload: unknown) => unknown | Promise<unknown>;
}

type Call = { channel: string; payload: unknown };

function mockIpc(options: Options = {}): Call[] {
  const calls: Call[] = [];
  const allowed = options.allowedBackends ?? null;
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    const custom = await options.handle?.(channel, payload);
    if (custom !== undefined) return { ok: true, data: custom };
    const confirmed = (payload as { confirm?: boolean } | undefined)?.confirm === true;
    switch (channel) {
      case "agents:listDetailed":
        return { ok: true, data: { agents: options.agents ?? [agent()] } };
      case "runtime:status": {
        const { provider, executablePath } = payload as { provider: string; executablePath?: string | null };
        return { ok: true, data: { runtime: options.runtime?.(provider, executablePath ?? null) ?? null } };
      }
      case "providers:capabilities": {
        const { provider, refreshModels } = payload as { provider: string; refreshModels: boolean };
        const caps = capabilities(provider);
        const models = refreshModels && provider === "claude" && !options.modelProblem ? CLAUDE_MODELS : caps.models;
        return { ok: true, data: { capabilities: { ...caps, models }, models, problem: refreshModels ? (options.modelProblem ?? null) : null } };
      }
      case "agents:save": {
        const { provider } = payload as { provider: string };
        if (allowed !== null && !allowed.includes(provider)) {
          return { ok: true, data: { saved: false, agent: null, problem: `The "${provider}" backend is ${NOT_ALLOWED_BY_YOUR_ORGANISATION}, so nothing was saved.` } };
        }
        return { ok: true, data: { saved: true, agent: { id: "a1" }, problem: null } };
      }
      case "agents:setBinding":
        return { ok: true, data: { bound: true, problem: null } };
      case "agents:archive":
        return { ok: true, data: { archived: confirmed && !options.removeProblem, problem: options.removeProblem ?? null, impact: options.removeProblem ? null : options.impact } };
      case "agents:delete":
        return { ok: true, data: { deleted: confirmed && !options.removeProblem, problem: options.removeProblem ?? null, impact: options.removeProblem ? null : options.impact } };
      case "mcpServers:list":
        return { ok: true, data: { servers: options.servers ?? [], keychain: { available: true, backend: "gnome_libsecret", weak: false, warning: null } } };
      case "skills:list":
        return { ok: true, data: { skills: [] } };
      case "agentAttachments:list":
        return { ok: true, data: { attachments: [] } };
      case "agentAttachments:set":
        return { ok: true, data: { attachments: null, problem: null } };
      case "registry:get":
        return { ok: true, data: registryView };
      case "policy:get":
        return { ok: true, data: { policy: { ...NO_POLICY, allowedBackends: allowed }, fromServer: allowed !== null, yours: null } };
      case "sections:list":
        return {
          ok: true,
          data: {
            published: options.locked
              ? [{ section: "agents", subjectId: "", versionId: null, versionNumber: null, publishedAt: 1, publishedBy: "dana-id", publishedByName: "Dana", document: null }]
              : [],
            locked: options.locked ? ["agents"] : [],
            lockText: SECTION_LOCK_TEXT,
          },
        };
      default:
        return { ok: true, data: {} };
    }
  }) as never;
  return calls;
}

function mount(address = "/agents") {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[address]}>
        <ViewPublisher>
          <AgentsView />
        </ViewPublisher>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderAgents(options: Options = {}, address?: string): Call[] {
  const calls = mockIpc(options);
  mount(address);
  return calls;
}

/** The editor of the first agent, which is open before anything is clicked. */
async function editor() {
  const list = await screen.findByRole("list", { name: "Agents" });
  await within(list).findAllByRole("button", { name: /Implementer|Orion|Tester/ });
  return screen.findByRole("region", { name: "Edit agent" });
}

function savedConfig(calls: Call[]): Record<string, unknown> | undefined {
  const save = calls.filter((call) => call.channel === "agents:save").at(-1);
  return save ? (save.payload as { config: Record<string, unknown> }).config : undefined;
}

function lastPublished(calls: Call[]): Record<string, unknown> {
  const publishes = calls.filter((call) => call.channel === "view:publish");
  return (publishes.at(-1)?.payload as Record<string, unknown>) ?? {};
}

afterEach(() => setBridge(undefined));

describe("configuring an agent", () => {
  it("offers the models the provider reports, and saves the chosen one", async () => {
    const calls = renderAgents();
    const pane = await editor();
    await waitFor(() => expect(within(pane).getByRole("option", { name: "Opus 5" })).toBeInTheDocument());

    fireEvent.change(within(pane).getByLabelText("Model"), { target: { value: "claude-opus-5" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(calls.find((call) => call.channel === "agents:save")?.payload).toMatchObject({ model: "claude-opus-5" }));
  });

  it("offers effort only for a model that takes one, at the levels it takes", async () => {
    renderAgents();
    const pane = await editor();
    await waitFor(() => expect(within(pane).getByRole("option", { name: "Opus 5" })).toBeInTheDocument());

    fireEvent.change(within(pane).getByLabelText("Model"), { target: { value: "claude-haiku-4-5" } });
    expect(within(pane).queryByLabelText("Reasoning effort")).not.toBeInTheDocument();

    fireEvent.change(within(pane).getByLabelText("Model"), { target: { value: "claude-opus-5" } });
    const effort = await within(pane).findByLabelText("Reasoning effort");
    expect(within(effort).getByRole("option", { name: "high" })).toBeInTheDocument();
    expect(within(effort).queryByRole("option", { name: "xhigh" })).not.toBeInTheDocument();
  });

  it("writes a backend's settings into the agent's config and draws none EO has decided", async () => {
    const calls = renderAgents({ agents: [agent({ provider: "codex", role: "tester" })] });
    const pane = await editor();

    fireEvent.change(await within(pane).findByLabelText("Reasoning effort"), { target: { value: "high" } });
    expect(within(pane).queryByLabelText("Permission mode")).not.toBeInTheDocument();
    expect(within(pane).queryByLabelText("Sandbox")).not.toBeInTheDocument();
    fireEvent.click(within(pane).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(savedConfig(calls)).toEqual({ reasoningEffort: "high" }));
  });

  // Max turns is offered on no backend (EO-375): Codex has no
  // equivalent, so it went from both. A stored `maxTurns` from an older
  // EO is the case where a field drawn from config would reappear.
  it.each(["claude", "codex", "fake"])("draws no max turns field, on %s", async (provider) => {
    renderAgents({ agents: [agent({ provider, config: { maxTurns: 12 } })] });
    const pane = await editor();
    // Something that is only drawn once the capabilities have come back,
    // so a field that is merely late cannot pass this.
    if (provider === "claude") await within(pane).findByRole("option", { name: "Opus 5" });
    if (provider === "codex") await within(pane).findByLabelText("Reasoning effort");
    if (provider === "fake") await within(pane).findByText("The fake provider has no model.");

    expect(within(pane).queryByLabelText("Max turns")).not.toBeInTheDocument();
  });

  it("stays usable when the provider cannot be asked", async () => {
    renderAgents({ modelProblem: "Could not ask Claude which models are available. You can still type a model name." });
    const pane = await editor();

    expect(await within(pane).findByText(/still type a model name/)).toBeInTheDocument();
    fireEvent.change(within(pane).getByLabelText("Model"), { target: { value: "__custom__" } });
    fireEvent.change(within(pane).getByLabelText("Model"), { target: { value: "claude-something-new" } });
    expect(within(pane).getByLabelText("Model")).toHaveValue("claude-something-new");
  });

  it("says the fake provider has no model", async () => {
    renderAgents({ agents: [agent({ provider: "fake" })] });
    expect(within(await editor()).getByText("The fake provider has no model.")).toBeInTheDocument();
  });

  it("offers the shipped default over edited instructions, as a draft", async () => {
    renderAgents({ agents: [agent({ instructions: "My own prompt.", defaultInstructions: "The shipped one." })] });
    const pane = await editor();

    expect(within(pane).getByText(/differ from the instructions EO ships/)).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole("button", { name: "Load default" }));
    expect(within(pane).getByRole("textbox", { name: "Instructions" })).toHaveValue("The shipped one.");
    expect(within(pane).queryByRole("button", { name: "Load default" })).not.toBeInTheDocument();
  });

  it("says when the instructions being typed name a tool EO renamed", async () => {
    renderAgents({ agents: [agent({ instructions: "Nothing deprecated here." })] });
    const pane = await editor();
    expect(within(pane).queryByText(/uses ticket_\* names/)).not.toBeInTheDocument();

    fireEvent.change(within(pane).getByRole("textbox", { name: "Instructions" }), { target: { value: "Move it with ticket_move when you are done." } });

    expect(within(pane).getByText(/uses ticket_\* names/)).toBeInTheDocument();
    expect(within(pane).getByText("mcp__eo__item_move")).toBeInTheDocument();
  });

  it("names a machine-specific value in the instructions by its line, beside the renamed-tool notice, and saves anyway (EO-450)", async () => {
    const calls = renderAgents({ agents: [agent({ instructions: "Nothing machine-specific here." })] });
    const pane = await editor();
    expect(within(pane).queryByRole("note", { name: "Machine-specific values" })).not.toBeInTheDocument();

    const typed = "Read it with ticket_detail.\nThe API is at http://127.0.0.1:8080.";
    fireEvent.change(within(pane).getByRole("textbox", { name: "Instructions" }), { target: { value: typed } });

    expect(within(pane).getByText(/uses ticket_\* names/)).toBeInTheDocument();
    expect(within(pane).getByRole("note", { name: "Machine-specific values" })).toHaveTextContent("instructions line 2: 127.0.0.1:8080");

    fireEvent.click(within(pane).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.find((call) => call.channel === "agents:save")?.payload).toMatchObject({ instructions: typed }));
  });

  it("says a signed-out runtime is not signed in, asking about this agent's own executable", async () => {
    const asked: (string | null)[] = [];
    renderAgents({
      agents: [agent({ provider: "codex", config: { executablePath: "/usr/local/bin/codex" } })],
      runtime: (provider, executablePath) => {
        asked.push(executablePath);
        if (provider !== "codex") return null;
        return executablePath === null ? CODEX : { ...CODEX, source: "configured", path: executablePath, auth: SIGNED_OUT };
      },
    });
    const pane = await editor();

    expect(await within(pane).findByText("Not signed in")).toBeInTheDocument();
    expect(within(pane).queryByText("Connected")).not.toBeInTheDocument();
    expect(asked).toContain("/usr/local/bin/codex");
  });
});

const REUSE = /Reuse the thread for a whole ticket/;
const AMBIENT = /Let this agent use your own Claude setup/;
const CODEX_AMBIENT = /Let this agent use your own Codex setup/;

/**
 * The system agent's consolidation override (EO-578): a model and a
 * reasoning effort, each optional, kept in the agent's own config and
 * drawn on its editor — nowhere else.
 */
describe("what memory consolidation runs on", () => {
  const SYSTEM = agent({ id: "s1", name: "Orion", role: "system", model: "claude-opus-5", config: { effort: "low" } });

  it("follows the system agent until a field is set, and saves each field set into the agent's own config", async () => {
    const calls = renderAgents({ agents: [SYSTEM] });
    const pane = await editor();
    const card = await within(pane).findByRole("region", { name: "Memory consolidation" });
    await waitFor(() => expect(within(card).getByRole("option", { name: "Opus 5" })).toBeInTheDocument());

    const model = within(card).getByLabelText("Consolidation model");
    expect(model).toHaveValue("");
    expect(within(model).getByRole("option", { name: "follows the agent (claude-opus-5)" })).toBeInTheDocument();
    const effort = within(card).getByLabelText("Consolidation reasoning effort");
    expect(within(effort).getByRole("option", { name: "follows the agent (low)" })).toBeInTheDocument();
    // The agent's own fields are not the override's.
    expect(within(pane).getByLabelText("Model")).toHaveValue("claude-opus-5");

    fireEvent.change(effort, { target: { value: "high" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(savedConfig(calls)).toEqual({ effort: "low", consolidationReasoningEffort: "high" }));

    fireEvent.change(model, { target: { value: "claude-haiku-4-5" } });
    fireEvent.change(within(card).getByLabelText("Consolidation reasoning effort"), { target: { value: "" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(savedConfig(calls)).toEqual({ effort: "low", consolidationModel: "claude-haiku-4-5" }));
  });

  it("shows what is stored, and empties a field back to following the agent", async () => {
    const calls = renderAgents({ agents: [{ ...SYSTEM, config: { effort: "low", consolidationModel: "claude-haiku-4-5", consolidationReasoningEffort: "high" } }] });
    const pane = await editor();
    const card = await within(pane).findByRole("region", { name: "Memory consolidation" });
    await waitFor(() => expect(within(card).getByLabelText("Consolidation model")).toHaveValue("claude-haiku-4-5"));
    expect(within(card).getByLabelText("Consolidation reasoning effort")).toHaveValue("high");

    fireEvent.change(within(card).getByLabelText("Consolidation model"), { target: { value: "" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(savedConfig(calls)).toEqual({ effort: "low", consolidationReasoningEffort: "high" }));
  });

  it("is on no other agent's editor", async () => {
    renderAgents();
    const pane = await editor();
    await within(pane).findByRole("option", { name: "Opus 5" });
    expect(within(pane).queryByRole("region", { name: "Memory consolidation" })).not.toBeInTheDocument();
    expect(within(pane).queryByLabelText("Consolidation model")).not.toBeInTheDocument();
  });

  it("is not on the Runtimes tab", async () => {
    renderAgents({ agents: [SYSTEM], runtime: (provider) => (provider === "codex" ? CODEX : ABSENT) });
    await editor();
    fireEvent.click(screen.getByRole("tab", { name: "Runtimes" }));
    await screen.findByRole("region", { name: "Codex runtime" });
    expect(screen.queryByText(/consolidation/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Consolidation model")).not.toBeInTheDocument();
  });
});

describe("EO's own switches", () => {
  it("reuses a thread per item, in the project's own word, and survives a save", async () => {
    const calls = renderAgents({ agents: [agent({ role: "tester", config: { effort: "high" } })] });
    const pane = await editor();

    const box = await within(pane).findByRole("checkbox", { name: REUSE });
    expect(box).toHaveAccessibleName(/saves the tokens/);
    expect(box).toHaveAccessibleName(/until that ticket is done/);
    fireEvent.click(box);
    fireEvent.click(within(pane).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(savedConfig(calls)).toEqual({ effort: "high", reuseThreadPerItem: true }));
  });

  it.each(["system", "implementer", "reviewer"])("draws no reuse checkbox for the shipped %s role", async (role) => {
    renderAgents({ agents: [agent({ role })] });
    const pane = await editor();

    expect(within(pane).getByRole("checkbox", { name: AMBIENT })).toBeInTheDocument();
    expect(within(pane).queryByRole("checkbox", { name: REUSE })).not.toBeInTheDocument();
  });

  it("recomputes it as a new agent's role is typed, and leaves nothing behind untouched", async () => {
    const calls = renderAgents();
    await editor();

    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    const pane = screen.getByRole("region", { name: "Edit agent" });
    expect(within(pane).getByRole("checkbox", { name: REUSE })).not.toBeChecked();

    fireEvent.change(within(pane).getByLabelText(/^Role/), { target: { value: "reviewer" } });
    expect(within(pane).queryByRole("checkbox", { name: REUSE })).not.toBeInTheDocument();
    fireEvent.change(within(pane).getByLabelText(/^Role/), { target: { value: "fresh" } });
    expect(within(pane).getByRole("checkbox", { name: REUSE })).toBeInTheDocument();

    fireEvent.change(within(pane).getByLabelText("Display name"), { target: { value: "Fresh" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(savedConfig(calls)).toEqual({}));
  });

  it("offers the person's own Claude setup on Claude, and clears the key on untick", async () => {
    const calls = renderAgents({ agents: [agent({ config: { inheritAmbientConfig: true, effort: "high" } })] });
    const pane = await editor();

    const box = within(pane).getByRole("checkbox", { name: AMBIENT });
    expect(box).toHaveAccessibleName(/repository's own CLAUDE\.md and project settings apply either way/);
    expect(box).toBeChecked();
    fireEvent.click(box);
    fireEvent.click(within(pane).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(savedConfig(calls)).toEqual({ effort: "high" }));

    cleanup();
    renderAgents({ agents: [agent({ provider: "codex" })] });
    expect(within(await editor()).queryByRole("checkbox", { name: AMBIENT })).not.toBeInTheDocument();
  });

  it("offers the person's own Codex setup on Codex, and it survives a save (EO-378)", async () => {
    const calls = renderAgents({ agents: [agent({ provider: "codex", config: { reasoningEffort: "high" } })] });
    const pane = await editor();

    const box = within(pane).getByRole("checkbox", { name: CODEX_AMBIENT });
    expect(box).toHaveAccessibleName(/MCP servers in your ~\/\.codex/);
    expect(box).toHaveAccessibleName(/Your Codex sign-in, your saved conversations and the repository's own AGENTS\.md apply either way/);
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    fireEvent.click(within(pane).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(savedConfig(calls)).toEqual({ reasoningEffort: "high", inheritAmbientConfig: true }));
  });

  it("says a Codex agent runs with the person's own setup when their sign-in is in the keyring (EO-378)", async () => {
    renderAgents({ agents: [agent({ provider: "codex" })], runtime: (provider) => (provider === "codex" ? { ...CODEX, codexSignInInKeyring: true } : null) });
    const pane = await editor();

    expect(await within(pane).findByText(/Your Codex is set to keep its sign-in in your operating system's keyring/)).toHaveTextContent(/runs with your own Codex setup/);
    fireEvent.click(within(pane).getByRole("checkbox", { name: CODEX_AMBIENT }));
    expect(within(pane).queryByText(/keep its sign-in in your operating system's keyring/)).not.toBeInTheDocument();
  });

  it("says a Codex agent's memory calls are unavailable with a keyring sign-in, ticked or not (EO-509)", async () => {
    renderAgents({ agents: [agent({ provider: "codex" })], runtime: (provider) => (provider === "codex" ? { ...CODEX, codexSignInInKeyring: true } : null) });
    const pane = await editor();

    const notice = await within(pane).findByText(/EO's memory calls are unavailable on Codex while it keeps its sign-in in your operating system's keyring/);
    expect(notice).toHaveTextContent(/set cli_auth_credentials_store = "file" in your ~\/\.codex\/config\.toml and sign in to Codex again/);
    // EO's memory calls never use the person's own home, so the box does not change it.
    fireEvent.click(within(pane).getByRole("checkbox", { name: CODEX_AMBIENT }));
    expect(within(pane).getByText(/EO's memory calls are unavailable on Codex while it keeps its sign-in in your operating system's keyring/)).toBeInTheDocument();
  });

  it("says nothing about memory on a Codex agent whose sign-in is a file", async () => {
    renderAgents({ agents: [agent({ provider: "codex" })], runtime: (provider) => (provider === "codex" ? CODEX : null) });
    const pane = await editor();
    await within(pane).findByRole("checkbox", { name: CODEX_AMBIENT });
    expect(within(pane).queryByText(/memory calls are unavailable/)).not.toBeInTheDocument();
  });
});

describe("giving an agent its tools", () => {
  const GITHUB = {
    id: "019fb8c6-0000-7000-8000-0000000000a1",
    name: "github",
    description: "",
    config: { transport: "stdio", command: "npx", args: [] },
    envNames: [],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    connector: null,
    secretsSet: [],
  };

  it("ticks a server onto the agent on its own channel, and says when it lands", async () => {
    const calls = renderAgents({ servers: [GITHUB] });
    const pane = await editor();

    fireEvent.click(await within(pane).findByRole("checkbox", { name: "github" }));
    await waitFor(() =>
      expect(calls.find((call) => call.channel === "agentAttachments:set")?.payload).toEqual({ agentId: "a1", kind: "mcpServer", id: GITHUB.id, attached: true }),
    );
    expect(calls.some((call) => call.channel === "agents:save")).toBe(false);
    expect(within(pane).getByText(/Applies from the next dispatch/)).toHaveTextContent("starts a fresh conversation on that ticket");
  });

  it("offers nothing to tick until the agent exists", async () => {
    renderAgents({ servers: [GITHUB] });
    await editor();

    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    const pane = screen.getByRole("region", { name: "Edit agent" });
    expect(within(pane).queryByRole("checkbox", { name: "github" })).not.toBeInTheDocument();
    expect(within(pane).getByText(/Create the agent first/)).toBeInTheDocument();
  });
});

describe("retiring an agent", () => {
  const LIVE = agent({ provider: "fake", instructions: "Write the code." });
  const RETIRED = agent({ id: "a2", name: "Architect", role: "pipeline_architect", provider: "fake", enabled: false, archivedAt: 1_700_000_000_000 });
  const TESTER = agent({ id: "a3", name: "Tester", role: "tester", provider: "fake" });
  const IMPACT = {
    agentName: "Tester",
    role: "tester",
    steps: [{ stepId: "s1", stepName: "Test", pipelineId: "p1", pipelineName: "Delivery" }],
    leavesStepsWithNobody: true,
    coveredBy: [],
    activeRuns: [{ runId: "r1", itemId: "i1", itemKey: "EO-7", itemTitle: "Checkout flow" }],
    lastSystemAgent: false,
  };

  it("hides an archived agent until asked, and offers it only Edit and Delete", async () => {
    renderAgents({ agents: [LIVE, RETIRED] });
    const list = await screen.findByRole("list", { name: "Agents" });
    await within(list).findByText("Implementer");
    expect(within(list).queryByText("Architect")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show archived (1)" }));
    expect(within(list).getByText("Architect")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Actions for Architect" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Enable" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("offers only Edit while the organisation manages the agents section", async () => {
    renderAgents({ agents: [LIVE], locked: true });
    await screen.findByRole("button", { name: "Actions for Implementer" });
    await waitFor(() => expect(screen.getByRole("button", { name: "New agent" })).toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "Actions for Implementer" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Disable" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("disables an agent from its menu through the agent save", async () => {
    const calls = renderAgents({ agents: [LIVE] });
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Implementer" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Disable" }));

    await waitFor(() => expect(calls.find((call) => call.channel === "agents:save")?.payload).toMatchObject({ id: "a1", enabled: false }));
  });

  it("archives only once the confirmation, naming what it takes away, is accepted", async () => {
    const calls = renderAgents({ agents: [LIVE, TESTER], impact: IMPACT });
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Tester" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    const dialog = await screen.findByRole("dialog", { name: "Archive Tester?" });
    expect(await within(dialog).findByText("Test")).toBeInTheDocument();
    expect(within(dialog).getByText(/in Delivery/)).toBeInTheDocument();
    // In the project's own word for the things that would wait.
    expect(within(dialog).getByText(/These steps will have nobody, and tickets reaching them/)).toBeInTheDocument();
    expect(within(dialog).getByRole("alert", { name: "Runs in progress" }).textContent).toMatch(/EO-7.*Checkout flow/);
    expect(calls.filter((call) => call.channel === "agents:archive").map((call) => call.payload)).toEqual([{ id: "a3", confirm: false }]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Archive Tester" }));
    await waitFor(() => expect(calls.filter((call) => call.channel === "agents:archive").map((call) => call.payload)).toContainEqual({ id: "a3", confirm: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the confirmation open while the archive is in flight, so its refusal is read", async () => {
    let answer: (value: unknown) => void = () => undefined;
    renderAgents({
      agents: [LIVE, TESTER],
      impact: IMPACT,
      handle: (channel, payload) =>
        channel === "agents:archive" && (payload as { confirm?: boolean }).confirm === true
          ? new Promise((resolve) => {
              answer = resolve;
            })
          : undefined,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Tester" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive Tester?" });
    await within(dialog).findByText("Test");

    fireEvent.click(within(dialog).getByRole("button", { name: "Archive Tester" }));
    // In flight: Escape and the X do not take the answer away from the person.
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close dialog" })).toBeDisabled());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Archive Tester?" })).toBeInTheDocument();

    await act(async () => answer({ archived: false, problem: "Tester started a run a moment ago.", impact: IMPACT }));
    expect(await within(screen.getByRole("dialog", { name: "Archive Tester?" })).findByText("Tester started a run a moment ago.")).toBeInTheDocument();
  });

  it("deletes nothing when the confirmation is dismissed, and says who still covers the role", async () => {
    const calls = renderAgents({ agents: [LIVE], impact: { ...IMPACT, agentName: "Implementer", leavesStepsWithNobody: false, coveredBy: ["Second Implementer"], activeRuns: [] } });
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Implementer" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog", { name: "Delete Implementer?" });
    expect(await within(dialog).findByText("Still covered by Second Implementer.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.filter((call) => call.channel === "agents:delete").map((call) => call.payload)).toEqual([{ id: "a1", confirm: false }]);
  });

  it("shows a refusal as the sentence it came back as, with nothing to confirm", async () => {
    renderAgents({ agents: [LIVE], removeProblem: "That agent no longer exists." });
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Implementer" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    const dialog = await screen.findByRole("dialog", { name: "Archive Implementer?" });
    expect(await within(dialog).findByText("That agent no longer exists.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Archive Implementer" })).not.toBeInTheDocument();
    // Nothing to keep: the way out says it closes (beside the dialog's own close).
    expect(within(dialog).queryByRole("button", { name: "Keep it" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Close dialog" })).toBeInTheDocument();
  });
});

describe("what the Agents view publishes", () => {
  const TWO = [agent({ id: "a1", name: "Orion" }), agent({ id: "a2", name: "Vega", role: "reviewer" })];

  it("publishes the agent that is open before anything is clicked, and the one a filter leaves open", async () => {
    const calls = renderAgents({ agents: TWO });
    await editor();
    await waitFor(() => expect(lastPublished(calls)["selection"]).toEqual(["a1"]));

    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "Vega" } });
    await waitFor(() => {
      expect(lastPublished(calls)["selection"]).toEqual(["a2"]);
      expect(lastPublished(calls)["filter"]).toEqual({ text: "Vega", facets: { tab: "agents", role: "all", status: "all", archived: "false" } });
    });
  });

  it("publishes nothing selected while New agent is open", async () => {
    const calls = renderAgents({ agents: TWO });
    await editor();
    await waitFor(() => expect(lastPublished(calls)["selection"]).toEqual(["a1"]));

    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    await waitFor(() => expect(lastPublished(calls)["selection"]).toEqual([]));
  });

  it("publishes only the tab on Runtimes, and brings the selection back on Agents", async () => {
    const calls = renderAgents({ agents: TWO });
    await editor();

    fireEvent.click(screen.getByRole("tab", { name: "Runtimes" }));
    await waitFor(() => {
      expect(lastPublished(calls)["selection"]).toEqual([]);
      expect(lastPublished(calls)["filter"]).toEqual({ text: "", facets: { tab: "runtimes" } });
    });

    fireEvent.click(screen.getByRole("tab", { name: /^Agents/ }));
    await waitFor(() => expect(lastPublished(calls)["selection"]).toEqual(["a1"]));
  });
});

describe("what the organisation allows and manages", () => {
  it("greys a backend outside the list, keeps the agent's own selectable, and says so", async () => {
    renderAgents({ agents: [agent({ provider: "codex" })], allowedBackends: ["claude"] });
    const pane = await editor();

    const runtime = within(pane).getByRole("combobox", { name: /^Runtime/ });
    await waitFor(() => expect(within(runtime).getByRole("option", { name: `Built in (fake) — ${NOT_ALLOWED_BY_YOUR_ORGANISATION}` })).toBeDisabled());
    expect(within(runtime).getByRole("option", { name: `Codex — ${NOT_ALLOWED_BY_YOUR_ORGANISATION}` })).not.toBeDisabled();
    expect(await within(pane).findByRole("alert")).toHaveTextContent(NOT_ALLOWED_BY_YOUR_ORGANISATION);
  });

  it("shows the command's refusal and keeps what was typed", async () => {
    renderAgents({ agents: [agent({ provider: "codex" })], allowedBackends: ["claude"] });
    const pane = await editor();

    fireEvent.change(within(pane).getByLabelText("Display name"), { target: { value: "Renamed" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(within(pane).getAllByRole("alert").map((node) => node.textContent).join(" ")).toContain("so nothing was saved"));
    expect(within(pane).getByLabelText("Display name")).toHaveValue("Renamed");
  });

  it("fences the published fields, leaves the backend live, and saves it through the binding", async () => {
    const calls = renderAgents({ agents: [agent({ instructions: "The organisation's prompt." })], locked: true });
    const pane = await editor();

    await waitFor(() => expect(screen.getAllByTestId("managed-lock-agents").length).toBeGreaterThan(0));
    expect(within(pane).getByRole("textbox", { name: "Instructions" })).toBeDisabled();
    expect(within(pane).getByLabelText("Display name")).toBeDisabled();
    expect(within(pane).getByRole("combobox", { name: /^Runtime/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "New agent" })).toBeDisabled();

    fireEvent.change(within(pane).getByRole("combobox", { name: /^Runtime/ }), { target: { value: "codex" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Save backend" }));

    await waitFor(() => expect(calls.find((call) => call.channel === "agents:setBinding")?.payload).toMatchObject({ agentId: "a1", provider: "codex" }));
    expect(calls.some((call) => call.channel === "agents:save")).toBe(false);
  });
});

describe("the runtimes on this machine", () => {
  function renderRuntimes(machine: Record<string, RuntimeStatusView | null>, handle?: (channel: string, payload: unknown) => unknown) {
    const current = { ...machine };
    const calls = mockIpc({
      agents: [agent({ provider: "fake" })],
      runtime: (provider) => current[provider] ?? null,
      handle: (channel, payload) => {
        const answer = handle?.(channel, payload);
        if (answer !== undefined) return answer;
        const { provider } = (payload ?? {}) as { provider?: string };
        if (channel === "runtime:describe") return { packageName: ABSENT.packageName, packageVersion: ABSENT.packageVersion, unpackedBytes: 277_000_000, sourceUrl: null, problem: null };
        if (channel === "runtime:install" && provider) {
          current[provider] = { ...ABSENT, source: "cache", path: "/x/claude", version: "0.3.227", state: "ready", automaticUpdates: true, auth: SIGNED_IN };
          return { ok: true, problem: null, runtime: current[provider] };
        }
        if (channel === "runtime:setEnabled" && provider) {
          const { enabled } = payload as { enabled: boolean };
          current[provider] = { ...current[provider]!, enabled, state: enabled ? "ready" : "disabled" };
          return { ok: true, problem: null, runtime: current[provider] };
        }
        if (channel === "runtime:remove" && provider) {
          current[provider] = { ...current[provider]!, source: "absent", path: null, version: null, state: "needs_consent", automaticUpdates: false };
          return { ok: true, problem: null, runtime: current[provider] };
        }
        if (channel === "runtime:removeApiKey" && provider) {
          current[provider] = { ...current[provider]!, auth: SIGNED_OUT };
          return { ok: true, removed: true, problem: null };
        }
        return undefined;
      },
    });
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Runtimes" }));
    return calls;
  }

  it("lists what is installed, who uses it, and offers the rest from Add runtime", async () => {
    renderRuntimes({ codex: { ...CODEX, usedBy: [{ id: "a1", name: "Implementer", enabled: true }, { id: "a2", name: "Paused reviewer", enabled: false }] }, claude: ABSENT });

    const card = await screen.findByRole("region", { name: "Codex runtime" });
    expect(within(card).getByText(/Managed by EO/)).toBeInTheDocument();
    expect(within(card).getByText("0.147.0-linux-x64")).toBeInTheDocument();
    expect(within(card).getByText("Paused reviewer (disabled)")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Claude Code runtime" })).not.toBeInTheDocument();
    // The primary action is about the tab on screen.
    expect(screen.queryByRole("button", { name: "New agent" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add runtime" }));
    const dialog = await screen.findByRole("dialog", { name: "Add runtime" });
    expect(within(dialog).getByText("Claude Code")).toBeInTheDocument();
    expect(within(dialog).queryByText("Codex")).not.toBeInTheDocument();
  });

  it("says on the Codex card that EO's memory calls are unavailable with a keyring sign-in, and how to fix it (EO-509)", async () => {
    renderRuntimes({ codex: { ...CODEX, codexSignInInKeyring: true }, claude: ABSENT });

    const card = await screen.findByRole("region", { name: "Codex runtime" });
    const notice = await within(card).findByText(/EO's memory calls are unavailable on Codex while it keeps its sign-in in your operating system's keyring/);
    expect(notice).toHaveTextContent(/set cli_auth_credentials_store = "file" in your ~\/\.codex\/config\.toml and sign in to Codex again/);
    expect(notice).not.toHaveTextContent(/Claude/);
  });

  it("says nothing about memory on a Codex card whose sign-in is a file", async () => {
    renderRuntimes({ codex: CODEX, claude: ABSENT });
    const card = await screen.findByRole("region", { name: "Codex runtime" });
    expect(within(card).queryByText(/memory calls are unavailable/)).not.toBeInTheDocument();
  });

  it("says the tab is empty on purpose", async () => {
    renderRuntimes({ codex: { ...ABSENT, id: "codex", label: "Codex" }, claude: ABSENT });
    expect(await screen.findByText(/No runtimes on this machine yet/)).toBeInTheDocument();
  });

  it("asks before fetching anything, and fetches once agreed", async () => {
    const calls = renderRuntimes({ codex: CODEX, claude: ABSENT });
    await screen.findByRole("region", { name: "Codex runtime" });

    fireEvent.click(screen.getByRole("button", { name: "Add runtime" }));
    fireEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: /Claude Code/ }));
    const consent = await screen.findByRole("region", { name: "Download Claude Code" });
    expect(consent).toHaveTextContent("@anthropic-ai/claude-agent-sdk-linux-x64@0.3.227");
    expect(consent).toHaveTextContent("Anthropic PBC");
    expect(calls.some((call) => call.channel === "runtime:install")).toBe(false);

    fireEvent.click(within(consent).getByRole("button", { name: "Download" }));
    await waitFor(() => expect(calls.filter((call) => call.channel === "runtime:install")).toHaveLength(1));
    expect(await screen.findByRole("region", { name: "Claude Code runtime" })).toBeInTheDocument();
  });

  it("disables and enables the existing copy without touching automatic updates", async () => {
    const calls = renderRuntimes({ codex: { ...CODEX, enabled: true, usedBy: [] }, claude: ABSENT });
    const card = await screen.findByRole("region", { name: "Codex runtime" });

    fireEvent.click(within(card).getByRole("button", { name: "Disable" }));
    await within(card).findByText("Disabled");
    expect(within(card).getByRole("switch", { name: /Automatic updates/ })).toBeChecked();
    fireEvent.click(within(card).getByRole("button", { name: "Enable" }));
    await within(card).findByText("Connected");
    expect(calls.filter((call) => call.channel === "runtime:install")).toHaveLength(0);
  });

  it("asks before deleting, refuses while agents use it, and removes once confirmed", async () => {
    const calls = renderRuntimes({ codex: { ...CODEX, usedBy: [] }, claude: ABSENT });
    const card = await screen.findByRole("region", { name: "Codex runtime" });

    fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Codex" });
    expect(within(dialog).getByLabelText("Codex components to delete")).toHaveTextContent("Codex CLI");
    expect(within(dialog).getByText(/own executable path keeps using it/)).toBeInTheDocument();
    expect(calls.filter((call) => call.channel === "runtime:remove")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Codex" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Codex runtime" })).not.toBeInTheDocument());
    expect(calls.filter((call) => call.channel === "runtime:remove")).toHaveLength(1);
  });

  it("names the agents a removal is refused for, and disables it", async () => {
    renderRuntimes({ codex: { ...CODEX, usedBy: [{ id: "a1", name: "Implementer", enabled: true }] }, claude: ABSENT });
    fireEvent.click(within(await screen.findByRole("region", { name: "Codex runtime" })).getByRole("button", { name: "Remove" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove Codex" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Implementer");
    expect(within(dialog).getByRole("button", { name: "Remove Codex" })).toBeDisabled();
  });

  it("offers a way in on a signed-out runtime, and only there", async () => {
    renderRuntimes({ codex: { ...CODEX, auth: SIGNED_OUT }, claude: ABSENT });
    const card = await screen.findByRole("region", { name: "Codex runtime" });
    expect(within(card).getByText(/nothing can run on it until someone signs in/)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: /Authorize/ }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in to Codex" });
    // What starting a Codex sign-in costs, said before it starts.
    expect(within(dialog).getByRole("alert")).toHaveTextContent("signs this machine out of Codex first");
  });

  it("removes a key EO holds, after which the runtime says what the binary says", async () => {
    renderRuntimes({ codex: CODEX, claude: { ...ABSENT, source: "cache", state: "ready", path: "/x/claude", auth: STORED_KEY } });
    const card = await screen.findByRole("region", { name: "Claude Code runtime" });
    expect(within(card).getByText(/stored by EO/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Codex runtime" })).queryByRole("button", { name: "Remove key" })).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Remove key" }));
    expect(await within(card).findByText(/nothing can run on it until someone signs in/)).toBeInTheDocument();
  });

  it("is not there where this machine cannot be asked", async () => {
    mockIpc();
    // An organisation server: the machine half of the contract is not there to ask.
    setBridge({
      invoke: ((channel: string, payload: unknown) => window.eo.ipc.invoke(channel as never, payload as never)) as never,
      machineAvailable: false,
      subscribe: () => () => {},
      subscribeRefetch: () => () => {},
    });
    mount();

    await editor();
    expect(screen.queryByRole("tab", { name: "Runtimes" })).not.toBeInTheDocument();
  });
});

describe("what the agent's role answers in (EO-427)", () => {
  it("draws the role's actions in the open agent's editor, read-only for one the pack ships", async () => {
    renderAgents({ agents: [agent({ id: "r1", name: "Orion", role: "reviewer" })] });
    const pane = await editor();

    const actions = await within(pane).findByRole("region", { name: "Actions" });
    const review = await within(actions).findByRole("listitem", { name: "review" });
    expect(within(review).getByText("changes_requested")).toBeInTheDocument();
    expect(within(review).queryByRole("button", { name: "Edit review" })).toBeNull();
  });

  it("leaves the section off an agent that has no role yet", async () => {
    renderAgents();
    await editor();
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));

    const pane = await screen.findByRole("region", { name: "Edit agent" });
    await waitFor(() => expect(within(pane).getByRole("button", { name: "Create agent" })).toBeInTheDocument());
    expect(within(pane).queryByRole("region", { name: "Actions" })).toBeNull();
  });

  it("offers no way to add or change one where the organisation manages the agents section", async () => {
    renderAgents({ agents: [agent({ id: "r1", name: "Orion", role: "reviewer" })], locked: true });
    const pane = await editor();

    const actions = await within(pane).findByRole("region", { name: "Actions" });
    await within(actions).findByRole("listitem", { name: "review" });
    await waitFor(() => expect(within(actions).getByText(SECTION_LOCK_TEXT, { exact: false })).toBeInTheDocument());
    expect(within(actions).queryByRole("button", { name: "New action" })).toBeNull();
  });
});

/**
 * Where the pipeline editor's "New action" lands (EO-428): a definition
 * is the role's, so the address names a role and the screen opens an
 * agent on it with the Actions section brought into sight.
 */
describe("the agents view opened on a role's actions", () => {
  afterEach(() => cleanup());
  const two = [agent(), agent({ id: "a2", name: "Tester", role: "qa" })];

  it("opens an agent on the role the address names, and brings its Actions section into sight", async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      renderAgents({ agents: two }, "/agents?actions=qa");
      const actions = await screen.findByRole("region", { name: "Actions" });
      expect(within(actions).getByText("qa")).toBeInTheDocument();
      await waitFor(() => expect(scrolled.some((element) => element.contains(actions))).toBe(true));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("opens a role's actions on a retired agent when nobody live holds the role, rather than another role's", async () => {
    // A step can still be owned by a role whose only agent was archived.
    const retired = [agent(), agent({ id: "a2", name: "Tester", role: "qa", archivedAt: 1_700_000_000_000 })];
    renderAgents({ agents: retired }, "/agents?actions=qa");
    expect(within(await screen.findByRole("region", { name: "Actions" })).getByText("qa")).toBeInTheDocument();
    // Listed while it is what is open, with archived agents otherwise still hidden.
    expect(within(screen.getByRole("list", { name: "Agents" })).getAllByRole("button", { name: /Tester/ }).length).toBeGreaterThan(0);
    cleanup();

    // A live agent on the role wins over a retired one.
    renderAgents({ agents: [...retired, agent({ id: "a3", name: "Checker", role: "qa" })] }, "/agents?actions=qa");
    await screen.findByRole("region", { name: "Actions" });
    expect(screen.getByRole("region", { name: "Edit agent" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Agents" })).queryByRole("button", { name: /Tester/ })).toBeNull();
    expect(within(screen.getByRole("list", { name: "Agents" })).getAllByRole("button", { name: /Checker/ }).length).toBeGreaterThan(0);
  });

  it("opens the first agent as ever when the address names no role, and lets the person pick another when it does", async () => {
    renderAgents({ agents: two });
    expect(within(await screen.findByRole("region", { name: "Actions" })).getByText("implementer")).toBeInTheDocument();
    cleanup();

    renderAgents({ agents: two }, "/agents?actions=qa");
    await screen.findByRole("region", { name: "Actions" });
    fireEvent.click(within(screen.getByRole("list", { name: "Agents" })).getAllByRole("button", { name: /Implementer/ })[0]!);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Actions" })).getByText("implementer")).toBeInTheDocument());
  });
});

describe("a project's own agents (EO-475)", () => {
  const SUPPORT = { id: "p-support", name: "Support" };
  const projectsList = {
    projects: [SUPPORT, { id: "p-shop", name: "Shop" }].map((project) => ({ ...project, keyPrefix: project.name.toUpperCase(), archivedAt: null, repositoryIds: [], itemCount: 0 })),
    activeProjectId: SUPPORT.id,
  };

  function lastSave(calls: Call[]): Record<string, unknown> | undefined {
    return calls.filter((call) => call.channel === "agents:save").at(-1)?.payload as Record<string, unknown> | undefined;
  }

  it("groups the list by scope: the global agents, then each project's own", async () => {
    renderAgents({
      agents: [agent({ projectId: null }), agent({ id: "a2", name: "Support implementer", projectId: SUPPORT.id })],
      handle: (channel) => (channel === "projects:list" ? projectsList : undefined),
    });

    const global = await screen.findByRole("region", { name: "Global agents" });
    const support = await screen.findByRole("region", { name: "Support's own agents" });
    expect(within(global).getAllByRole("button", { name: /^Implementer/ }).length).toBeGreaterThan(0);
    expect(within(support).getAllByRole("button", { name: /^Support implementer/ }).length).toBeGreaterThan(0);
    expect(within(global).queryByRole("button", { name: /^Support implementer/ })).toBeNull();
  });

  it("sets an agent's scope to a project through agents:save", async () => {
    const calls = renderAgents({ agents: [agent({ projectId: null })], handle: (channel) => (channel === "projects:list" ? projectsList : undefined) });
    const form = await editor();
    const scope = within(form).getByRole("combobox", { name: "Scope" });
    await within(scope).findByRole("option", { name: "Support" });

    fireEvent.change(scope, { target: { value: SUPPORT.id } });
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(lastSave(calls)?.["projectId"]).toBe(SUPPORT.id));
  });

  it("offers the system agent no scope and no copy", async () => {
    const calls = renderAgents({
      agents: [agent({ name: "Implementer", role: "system", projectId: null })],
      handle: (channel) => (channel === "projects:list" ? projectsList : undefined),
    });
    const form = await editor();

    expect(within(form).queryByRole("combobox", { name: "Scope" })).toBeNull();
    expect(within(form).queryByRole("button", { name: "Customise for this project" })).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(lastSave(calls)).toBeDefined());
    expect(lastSave(calls)).not.toHaveProperty("projectId");
  });

  it("shows the copy's tools ticked, and unticking one leaves the original's alone", async () => {
    // The original's attachments are already in the picker's cache when
    // the copy is made; the copy's editor must not draw from that answer.
    const GITHUB = { id: "srv-github", name: "github", config: { transport: "stdio", command: "npx", args: [] }, envNames: [], enabled: true, createdAt: 0, updatedAt: 0, archivedAt: null, secretsSet: [] };
    const copy = agent({ id: "a-copy", name: "Implementer (Support)", projectId: SUPPORT.id });
    const attached = new Map<string, string[]>([["a1", [GITHUB.id]]]);
    let listed: unknown[] = [agent({ projectId: null })];
    const calls = renderAgents({
      agents: listed,
      servers: [GITHUB],
      handle: (channel, payload) => {
        if (channel === "projects:list") return projectsList;
        if (channel === "agents:listDetailed") return { agents: listed };
        if (channel === "agents:customise") {
          listed = [...listed, copy];
          attached.set(copy.id as string, [...(attached.get("a1") ?? [])]);
          return { saved: true, agent: copy, problem: null };
        }
        if (channel === "agentAttachments:list") return { attachments: [...attached].map(([agentId, mcpServerIds]) => ({ agentId, mcpServerIds, skillIds: [] })) };
        if (channel === "agentAttachments:set") {
          const tick = payload as { agentId: string; id: string; attached: boolean };
          const held = (attached.get(tick.agentId) ?? []).filter((id) => id !== tick.id);
          attached.set(tick.agentId, tick.attached ? [...held, tick.id] : held);
          return { attachments: { agentId: tick.agentId, mcpServerIds: attached.get(tick.agentId), skillIds: [] }, problem: null };
        }
        return undefined;
      },
    });
    const form = await editor();
    await waitFor(() => expect(within(form).getByRole("checkbox", { name: "github" })).toBeChecked());

    fireEvent.click(within(form).getByRole("button", { name: "Customise for this project" }));

    await waitFor(() => expect(within(screen.getByRole("region", { name: "Edit agent" })).getByRole("heading", { name: "Implementer (Support)" })).toBeInTheDocument());
    const copyForm = screen.getByRole("region", { name: "Edit agent" });
    await waitFor(() => expect(within(copyForm).getByRole("checkbox", { name: "github" })).toBeChecked());

    fireEvent.click(within(copyForm).getByRole("checkbox", { name: "github" }));
    await waitFor(() =>
      expect(calls.filter((call) => call.channel === "agentAttachments:set").at(-1)?.payload).toEqual({ agentId: "a-copy", kind: "mcpServer", id: GITHUB.id, attached: false }),
    );
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Edit agent" })).getByRole("checkbox", { name: "github" })).not.toBeChecked());
    expect(attached.get("a1")).toEqual([GITHUB.id]);

    // The original, opened again, still has it.
    fireEvent.click(within(screen.getByRole("region", { name: "Global agents" })).getAllByRole("button", { name: /^Implementer/ })[0]!);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Edit agent" })).getByRole("heading", { name: "Implementer" })).toBeInTheDocument());
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Edit agent" })).getByRole("checkbox", { name: "github" })).toBeChecked());
  });

  it("customises a global agent for the active project and opens the copy", async () => {
    const copy = agent({ id: "a-copy", name: "Implementer (Support)", projectId: SUPPORT.id });
    let listed: unknown[] = [agent({ projectId: null })];
    const calls = renderAgents({
      agents: listed,
      handle: (channel) => {
        if (channel === "projects:list") return projectsList;
        if (channel === "agents:listDetailed") return { agents: listed };
        if (channel === "agents:customise") {
          listed = [...listed, copy];
          return { saved: true, agent: copy, problem: null };
        }
        return undefined;
      },
    });
    const form = await editor();

    fireEvent.click(await within(form).findByRole("button", { name: "Customise for this project" }));

    await waitFor(() => expect(calls.find((call) => call.channel === "agents:customise")?.payload).toEqual({ agentId: "a1", projectId: SUPPORT.id }));
    const support = await screen.findByRole("region", { name: "Support's own agents" });
    expect(within(support).getAllByRole("button", { name: /^Implementer \(Support\)/ }).length).toBeGreaterThan(0);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Edit agent" })).getByRole("heading", { name: "Implementer (Support)" })).toBeInTheDocument());
    expect(within(screen.getByRole("region", { name: "Edit agent" })).queryByRole("button", { name: "Customise for this project" })).toBeNull();
  });
});
