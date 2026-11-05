import type { ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMachineChannel, machineOnlyRefusal, ORGANISATION_SECRET_LINE, UNREADABLE_SERVER_SECRET_LINE, type IpcChannel, type McpKeychainStatus, type McpServerView } from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { ServerSecrets as ChatServerSecrets } from "../chat/views/agentTools/ServerSecrets";
import { ModuleSecrets as ChatModuleSecrets } from "../chat/modules/ModuleSecrets";
import { setBridge } from "../ipc/bridge";
import { createQueryClient } from "../query/client";
import { NOTHING_TO_REVEAL_LINE, REVEAL_FOR_MS, UNREADABLE_REVEAL_LINE } from "./useSecretReveal";

/**
 * Valid variable names that are also what every plain object inherits
 * (review). A row keyed by one of them must behave like any other name.
 */
const INHERITED_NAMES = ["constructor", "toString", "__proto__"] as const;

/** Answers a reveal with a value that says which name was asked for. */
const revealsByName = (payload: unknown) => ({ state: "value", value: `value-of-${(payload as { name: string }).name}` });

/**
 * Reveal (EO-489, ARCHITECTURE.md §14.2), on both secret rows: a
 * module's secrets and an MCP server's.
 *
 * One file over the two rather than two copies, so the rows cannot
 * drift: the cases they share run against each, and a component that
 * hides on Hide but not after thirty seconds fails here by name.
 *
 * What each case holds is one clause of the story. The value is asked
 * for only when Reveal is pressed; it goes again on Hide, on leaving the
 * screen, and after thirty seconds; it is never in the query cache; a
 * value that cannot be decrypted is a sentence, not an empty value; the
 * organisation's names and references have no Reveal; and a renderer
 * served by an organisation server draws no Reveal at all.
 */

interface Call {
  channel: string;
  payload: unknown;
}

type Answers = Record<string, unknown>;

const VALUE = "fly-token-shown-for-thirty-seconds";

function stubIpc(answers: Answers): Call[] {
  const calls: Call[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    const answer = Object.hasOwn(answers, channel) ? answers[channel] : {};
    return { ok: true, data: typeof answer === "function" ? (answer as (payload: unknown) => unknown)(payload) : answer };
  }) as never;
  return calls;
}

function sent(calls: Call[], channel: string): unknown[] {
  return calls.filter((call) => call.channel === channel).map((call) => call.payload);
}

function renderWithClient(node: ReactNode): ReturnType<typeof render> & { client: QueryClient } {
  const client = createQueryClient();
  const view = render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { ...view, client };
}

/** Everything the query cache holds, as one string to search. */
function cached(client: QueryClient): string {
  return JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data)) + JSON.stringify(client.getMutationCache().getAll().map((mutation) => mutation.state.data));
}

afterEach(() => {
  vi.useRealTimers();
  setBridge(undefined);
});

/** The served renderer's transport: the record half from the stub, the machine half refused as the server's door refuses it. */
function serveFromAServer(): Call[] {
  const calls: Call[] = [];
  setBridge({
    machineAvailable: false,
    invoke(channel, payload) {
      calls.push({ channel, payload });
      if (isMachineChannel(channel)) return Promise.resolve(machineOnlyRefusal(channel));
      return window.eo.ipc.invoke(channel, payload);
    },
    subscribe: () => () => {},
    subscribeRefetch: () => () => {},
  });
  return calls;
}

// ── Module secrets ───────────────────────────────────────────────────

describe.each([
  ["chat", ChatModuleSecrets],
] as const)("revealing a module secret, %s layout", (_layout, ModuleSecrets) => {
  const SHARED = { "moduleSecrets:list": { names: ["FLY_API_TOKEN"], overrides: [], organisation: [], references: [], stored: { shared: ["FLY_API_TOKEN"], step: [] } } };

  it("asks for the value only when Reveal is pressed, shows it, and hides it on Hide", async () => {
    const calls = stubIpc({ ...SHARED, "moduleSecrets:reveal": { state: "value", value: VALUE } });
    const { client } = renderWithClient(<ModuleSecrets />);

    const reveal = await screen.findByRole("button", { name: "Reveal FLY_API_TOKEN" });
    expect(sent(calls, "moduleSecrets:reveal")).toEqual([]);
    expect(document.body.textContent).not.toContain(VALUE);

    fireEvent.click(reveal);

    expect(await screen.findByLabelText("Value of FLY_API_TOKEN")).toHaveTextContent(VALUE);
    expect(sent(calls, "moduleSecrets:reveal")).toEqual([{ name: "FLY_API_TOKEN", stepId: null }]);
    // Held by the row and nowhere else.
    expect(cached(client)).not.toContain(VALUE);

    fireEvent.click(screen.getByRole("button", { name: "Hide FLY_API_TOKEN" }));

    expect(screen.queryByLabelText("Value of FLY_API_TOKEN")).toBeNull();
    expect(document.body.textContent).not.toContain(VALUE);
    expect(screen.getByRole("button", { name: "Reveal FLY_API_TOKEN" })).toBeInTheDocument();
  });

  it("hides the value again after thirty seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubIpc({ ...SHARED, "moduleSecrets:reveal": { state: "value", value: VALUE } });
    renderWithClient(<ModuleSecrets />);

    fireEvent.click(await screen.findByRole("button", { name: "Reveal FLY_API_TOKEN" }));
    expect(await screen.findByLabelText("Value of FLY_API_TOKEN")).toHaveTextContent(VALUE);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REVEAL_FOR_MS - 1_000);
    });
    expect(screen.getByLabelText("Value of FLY_API_TOKEN")).toHaveTextContent(VALUE);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByLabelText("Value of FLY_API_TOKEN")).toBeNull();
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it("hides the value when the person leaves the screen", async () => {
    stubIpc({ ...SHARED, "moduleSecrets:reveal": { state: "value", value: VALUE } });
    const first = renderWithClient(<ModuleSecrets />);

    fireEvent.click(await screen.findByRole("button", { name: "Reveal FLY_API_TOKEN" }));
    expect(await screen.findByLabelText("Value of FLY_API_TOKEN")).toHaveTextContent(VALUE);

    first.unmount();
    expect(document.body.textContent).not.toContain(VALUE);
    expect(cached(first.client)).not.toContain(VALUE);

    // Coming back is a fresh screen: the button again, not the value.
    renderWithClient(<ModuleSecrets />);
    expect(await screen.findByRole("button", { name: "Reveal FLY_API_TOKEN" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it("reveals a step's own override against that step, and offers none for the shared value a step only uses", async () => {
    const calls = stubIpc({
      "moduleSecrets:list": { names: ["FLY_API_TOKEN", "SLACK_WEBHOOK"], overrides: ["FLY_API_TOKEN"], organisation: [], references: [], stored: { shared: ["FLY_API_TOKEN", "SLACK_WEBHOOK"], step: ["FLY_API_TOKEN"] } },
      "moduleSecrets:reveal": { state: "value", value: VALUE },
    });
    renderWithClient(<ModuleSecrets stepId="step-1" declared={["FLY_API_TOKEN", "SLACK_WEBHOOK"]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Reveal FLY_API_TOKEN" }));

    expect(await screen.findByLabelText("Value of FLY_API_TOKEN")).toHaveTextContent(VALUE);
    expect(sent(calls, "moduleSecrets:reveal")).toEqual([{ name: "FLY_API_TOKEN", stepId: "step-1" }]);
    // Revealed where it is set — the shared list, in Settings.
    expect(screen.queryByRole("button", { name: "Reveal SLACK_WEBHOOK" })).toBeNull();
  });

  it("says a value that can no longer be decrypted cannot be read, rather than showing an empty one", async () => {
    stubIpc({ ...SHARED, "moduleSecrets:reveal": { state: "unreadable" } });
    renderWithClient(<ModuleSecrets />);

    fireEvent.click(await screen.findByRole("button", { name: "Reveal FLY_API_TOKEN" }));

    expect(await screen.findByText(UNREADABLE_REVEAL_LINE)).toBeInTheDocument();
    expect(screen.queryByLabelText("Value of FLY_API_TOKEN")).toBeNull();
  });

  it("says so when the value went between listing it and pressing Reveal", async () => {
    stubIpc({ ...SHARED, "moduleSecrets:reveal": { state: "absent" } });
    renderWithClient(<ModuleSecrets />);

    fireEvent.click(await screen.findByRole("button", { name: "Reveal FLY_API_TOKEN" }));

    expect(await screen.findByText(NOTHING_TO_REVEAL_LINE)).toBeInTheDocument();
  });

  it("offers no Reveal for the organisation's secret, a reference, or a name with nothing stored", async () => {
    const calls = stubIpc({
      "moduleSecrets:list": {
        // ORG has a personal value too; the row is the organisation's.
        names: ["ORG", "REF"],
        overrides: [],
        organisation: ["ORG"],
        references: [{ name: "REF", variable: "JDK21_HOME", scope: "shared", available: true }],
        stored: { shared: ["ORG"], step: [] },
      },
    });
    renderWithClient(<ModuleSecrets declared={["ORG", "REF", "UNSET"]} />);

    expect((await screen.findByText(ORGANISATION_SECRET_LINE)).parentElement).toHaveTextContent("ORG");
    await screen.findByText(/Reads JDK21_HOME/);
    for (const name of ["ORG", "REF", "UNSET"]) expect(screen.queryByRole("button", { name: `Reveal ${name}` }), name).toBeNull();
    expect(sent(calls, "moduleSecrets:reveal")).toEqual([]);
  });

  it("draws no Reveal on a renderer served by an organisation server", async () => {
    stubIpc(SHARED);
    const calls = serveFromAServer();
    renderWithClient(<ModuleSecrets />);

    // The row is there, and set — only the button is not.
    expect((await screen.findByText("FLY_API_TOKEN")).parentElement).toHaveTextContent("Set");
    expect(screen.queryByRole("button", { name: "Reveal FLY_API_TOKEN" })).toBeNull();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.filter((call) => isMachineChannel(call.channel as IpcChannel))).toEqual([]);
  });

  it("says a shared value that was already unreadable when listed cannot be read, and offers to remove it", async () => {
    // The shape `moduleSecrets:list` really answers for one: in `stored`,
    // and in neither `names` nor `overrides`, since no run would get it.
    const calls = stubIpc({
      "moduleSecrets:list": { names: [], overrides: [], organisation: [], references: [], stored: { shared: ["FLY_API_TOKEN"], step: [] } },
      "moduleSecrets:clear": { cleared: true },
    });
    renderWithClient(<ModuleSecrets />);

    expect(await screen.findByText("Stored as a secret, but it cannot be read")).toBeInTheDocument();
    expect(screen.getByText("FLY_API_TOKEN")).toBeInTheDocument();
    expect(screen.queryByText("Nothing set.")).toBeNull();
    expect(screen.queryByLabelText("Value of FLY_API_TOKEN")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal FLY_API_TOKEN" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove FLY_API_TOKEN" }));
    await waitFor(() => expect(sent(calls, "moduleSecrets:clear")).toEqual([{ name: "FLY_API_TOKEN", stepId: null }]));
    expect(sent(calls, "moduleSecrets:reveal")).toEqual([]);
  });

  it("says a step's own value that was already unreadable when listed cannot be read", async () => {
    stubIpc({
      "moduleSecrets:list": { names: ["FLY_API_TOKEN"], overrides: [], organisation: [], references: [], stored: { shared: ["FLY_API_TOKEN"], step: ["FLY_API_TOKEN"] } },
    });
    renderWithClient(<ModuleSecrets stepId="step-1" declared={["FLY_API_TOKEN"]} />);

    expect(await screen.findByText("Stored as a secret for this step, but it cannot be read")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal FLY_API_TOKEN" })).toBeNull();
    expect(screen.getByRole("button", { name: "Use the shared value for FLY_API_TOKEN" })).toBeInTheDocument();
  });

  it("reveals and hides names that every object inherits, like any other", async () => {
    const calls = stubIpc({
      "moduleSecrets:list": { names: [...INHERITED_NAMES], overrides: [], organisation: [], references: [], stored: { shared: [...INHERITED_NAMES], step: [] } },
      "moduleSecrets:reveal": revealsByName,
    });
    renderWithClient(<ModuleSecrets />);

    for (const name of INHERITED_NAMES) {
      fireEvent.click(await screen.findByRole("button", { name: `Reveal ${name}` }));
      expect(screen.queryByRole("button", { name: `Hide ${name}` })).not.toBeNull();
    }
    // Nothing was drawn before it was asked for, and nothing typed sits in a box.
    expect(document.body.textContent).not.toContain(NOTHING_TO_REVEAL_LINE);
    for (const name of INHERITED_NAMES) {
      expect(screen.getByLabelText(`Value for ${name}`)).toHaveValue("");
      expect(await screen.findByLabelText(`Value of ${name}`)).toHaveTextContent(`value-of-${name}`);
      fireEvent.click(screen.getByRole("button", { name: `Hide ${name}` }));
      expect(screen.queryByLabelText(`Value of ${name}`)).toBeNull();
      expect(screen.getByRole("button", { name: `Reveal ${name}` })).toBeEnabled();
    }
    expect(sent(calls, "moduleSecrets:reveal")).toEqual(INHERITED_NAMES.map((name) => ({ name, stepId: null })));
  });

  it("offers Reveal, not Hide, on a name every object inherits before anything is pressed", async () => {
    stubIpc({ "moduleSecrets:list": { names: [...INHERITED_NAMES], overrides: [], organisation: [], references: [], stored: { shared: [...INHERITED_NAMES], step: [] } } });
    renderWithClient(<ModuleSecrets />);

    for (const name of INHERITED_NAMES) expect(await screen.findByRole("button", { name: `Reveal ${name}` })).toBeEnabled();
    for (const name of INHERITED_NAMES) expect(screen.queryByRole("button", { name: `Hide ${name}` })).toBeNull();
    expect(document.body.textContent).not.toContain(NOTHING_TO_REVEAL_LINE);
  });
});

// ── MCP server secrets ───────────────────────────────────────────────

const KEYCHAIN: McpKeychainStatus = { available: true, backend: "gnome_libsecret", weak: false, warning: null };

const GITHUB: McpServerView = {
  id: "019fb8c6-0000-7000-8000-0000000000a1",
  name: "github",
  description: "",
  config: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  envNames: ["GITHUB_TOKEN", "GITHUB_ORG", "GITHUB_HOST"],
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  connector: null,
  secretsSet: ["GITHUB_TOKEN", "GITHUB_ORG"],
};

describe.each([
  ["chat", ChatServerSecrets],
] as const)("revealing an MCP server secret, %s layout", (_layout, ServerSecrets) => {
  it("asks for the value only when Reveal is pressed, shows it, and hides it on Hide", async () => {
    const calls = stubIpc({ "mcpServers:revealSecret": { state: "value", value: VALUE } });
    const { client } = renderWithClient(<ServerSecrets server={GITHUB} keychain={KEYCHAIN} />);

    const reveal = screen.getByRole("button", { name: "Reveal GITHUB_TOKEN for github" });
    expect(sent(calls, "mcpServers:revealSecret")).toEqual([]);

    fireEvent.click(reveal);

    expect(await screen.findByLabelText("Value of GITHUB_TOKEN on github")).toHaveTextContent(VALUE);
    expect(sent(calls, "mcpServers:revealSecret")).toEqual([{ serverId: GITHUB.id, name: "GITHUB_TOKEN" }]);
    expect(cached(client)).not.toContain(VALUE);

    fireEvent.click(screen.getByRole("button", { name: "Hide GITHUB_TOKEN for github" }));

    expect(screen.queryByLabelText("Value of GITHUB_TOKEN on github")).toBeNull();
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it("hides the value again after thirty seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubIpc({ "mcpServers:revealSecret": { state: "value", value: VALUE } });
    renderWithClient(<ServerSecrets server={GITHUB} keychain={KEYCHAIN} />);

    fireEvent.click(screen.getByRole("button", { name: "Reveal GITHUB_TOKEN for github" }));
    expect(await screen.findByLabelText("Value of GITHUB_TOKEN on github")).toHaveTextContent(VALUE);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REVEAL_FOR_MS);
    });
    expect(screen.queryByLabelText("Value of GITHUB_TOKEN on github")).toBeNull();
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it("hides the value when the person leaves the screen", async () => {
    stubIpc({ "mcpServers:revealSecret": { state: "value", value: VALUE } });
    const first = renderWithClient(<ServerSecrets server={GITHUB} keychain={KEYCHAIN} />);

    fireEvent.click(screen.getByRole("button", { name: "Reveal GITHUB_TOKEN for github" }));
    expect(await screen.findByLabelText("Value of GITHUB_TOKEN on github")).toHaveTextContent(VALUE);

    first.unmount();
    expect(document.body.textContent).not.toContain(VALUE);
    expect(cached(first.client)).not.toContain(VALUE);

    renderWithClient(<ServerSecrets server={GITHUB} keychain={KEYCHAIN} />);
    expect(screen.getByRole("button", { name: "Reveal GITHUB_TOKEN for github" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it("says a value that can no longer be decrypted cannot be read, rather than showing an empty one", async () => {
    stubIpc({ "mcpServers:revealSecret": { state: "unreadable" } });
    renderWithClient(<ServerSecrets server={GITHUB} keychain={KEYCHAIN} />);

    fireEvent.click(screen.getByRole("button", { name: "Reveal GITHUB_TOKEN for github" }));

    expect(await screen.findByText(UNREADABLE_REVEAL_LINE)).toBeInTheDocument();
    expect(screen.queryByLabelText("Value of GITHUB_TOKEN on github")).toBeNull();
  });

  it("offers no Reveal for a name the organisation supplies, or one with nothing stored", () => {
    // GITHUB_ORG has a personal value too; the row is the organisation's.
    stubIpc({});
    renderWithClient(<ServerSecrets server={GITHUB} keychain={KEYCHAIN} organisation={["GITHUB_ORG"]} />);

    expect(screen.getByText(ORGANISATION_SECRET_LINE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reveal GITHUB_TOKEN for github" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal GITHUB_ORG for github" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal GITHUB_HOST for github" })).toBeNull();
  });

  it("draws no Reveal on a renderer served by an organisation server", () => {
    stubIpc({});
    const calls = serveFromAServer();
    renderWithClient(<ServerSecrets server={GITHUB} keychain={KEYCHAIN} />);

    expect(screen.getByRole("button", { name: "Clear GITHUB_TOKEN for github" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal GITHUB_TOKEN for github" })).toBeNull();
    expect(document.body.textContent).not.toContain("revealed here");
    expect(calls.filter((call) => isMachineChannel(call.channel as IpcChannel))).toEqual([]);
  });

  it("says a value that was already unreadable when listed cannot be read, rather than 'Not set', and offers to clear it", () => {
    // The shape `mcpServers:list` really answers for one: in
    // `secretsUnreadable`, and not in `secretsSet`.
    const calls = stubIpc({ "mcpServers:clearSecret": { cleared: true } });
    renderWithClient(<ServerSecrets server={{ ...GITHUB, secretsSet: [], secretsUnreadable: ["GITHUB_TOKEN"] }} keychain={KEYCHAIN} variables={["GITHUB_TOKEN"]} />);

    expect(screen.getByText(UNREADABLE_SERVER_SECRET_LINE)).toBeInTheDocument();
    // Two names really are not set; the unreadable one is not counted with them.
    expect(screen.getAllByText("Not set")).toHaveLength(2);
    expect(screen.queryByText("From environment variables")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal GITHUB_TOKEN for github" })).toBeNull();
    expect(screen.queryByLabelText("Value of GITHUB_TOKEN on github")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear GITHUB_TOKEN for github" }));
    return waitFor(() => expect(sent(calls, "mcpServers:clearSecret")).toEqual([{ serverId: GITHUB.id, name: "GITHUB_TOKEN" }]));
  });

  it("reveals and hides names that every object inherits, like any other", async () => {
    const calls = stubIpc({ "mcpServers:revealSecret": revealsByName });
    renderWithClient(<ServerSecrets server={{ ...GITHUB, envNames: [...INHERITED_NAMES], secretsSet: [...INHERITED_NAMES] }} keychain={KEYCHAIN} />);

    // Reveal, not Hide, before anything is pressed — and nothing drawn yet.
    for (const name of INHERITED_NAMES) expect(screen.getByRole("button", { name: `Reveal ${name} for github` })).toBeEnabled();
    expect(document.body.textContent).not.toContain(NOTHING_TO_REVEAL_LINE);

    for (const name of INHERITED_NAMES) {
      expect(screen.getByLabelText(`Value for ${name} on github`)).toHaveValue("");
      fireEvent.click(screen.getByRole("button", { name: `Reveal ${name} for github` }));
      expect(await screen.findByLabelText(`Value of ${name} on github`)).toHaveTextContent(`value-of-${name}`);
      fireEvent.click(screen.getByRole("button", { name: `Hide ${name} for github` }));
      expect(screen.queryByLabelText(`Value of ${name} on github`)).toBeNull();
      expect(screen.getByRole("button", { name: `Reveal ${name} for github` })).toBeEnabled();
    }
    expect(sent(calls, "mcpServers:revealSecret")).toEqual(INHERITED_NAMES.map((name) => ({ serverId: GITHUB.id, name })));
  });
});
