import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerRegistry, NO_POLICY, SECTION_LOCK_TEXT, toRegistryView } from "@eo/core";
import type { RuntimeStatusView, TeamMemberView, TeamView } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { setBridge } from "../../../ipc/bridge";
import { ViewPublisher } from "../../../shared/view/ViewPublisher";
import { AskAssistantContext } from "../../askAssistant";
import { AgentsView } from "./AgentsView";

/**
 * The Teams tab of Agents (EO-884): every declared team with its leader
 * and members as the agents they are, what it may use, the steps running
 * as it and its versions — restored and locked from here, and changed in
 * instructions or membership only through the assistant.
 */

const registryView = toRegistryView(developerRegistry());

function member(overrides: Partial<TeamMemberView> = {}): TeamMemberView {
  return {
    agentId: "ag-criteria",
    name: "Criteria expert",
    kind: "reviewer",
    provider: "claude",
    model: "claude-opus-5",
    reasoning: "high",
    instructions: "Hold the change to every acceptance criterion.",
    teamInstructions: null,
    key: null,
    archived: false,
    addedBy: { kind: "eo" },
    ...overrides,
  };
}

function team(overrides: Partial<TeamView> = {}): TeamView {
  return {
    id: "team-1",
    projectId: "p1",
    projectName: "Shop",
    name: "EO reviewers",
    locked: false,
    version: 3,
    coordination: "leader",
    memberMode: "report_only",
    memberCap: 6,
    toolPool: { cliTools: ["gh"], mcpServers: ["repo"], skills: ["write-tests"] },
    modelRange: { runtimes: ["claude", "codex"], models: ["claude-opus-5", "gpt-5.1-codex"], reasoning: ["low", "high"] },
    limits: { maxParticipants: 4, maxParallel: 2, maxRetries: 1, maxRounds: 2 },
    leader: member({ agentId: "ag-lead", name: "Review lead", kind: "reviewer", teamInstructions: "Split the review by risk.", instructions: "Lead reviews." }),
    members: [
      member(),
      member({
        agentId: "ag-tests",
        name: "Test expert",
        provider: "codex",
        model: "gpt-5.1-codex",
        reasoning: "xhigh",
        instructions: "Find the tests that are missing.",
        addedBy: { kind: "leader", itemId: "item-42", itemKey: "EO-42" },
      }),
    ],
    steps: [{ stepId: "s-review", stepName: "Review", pipelineId: "pl-1", pipelineName: "Delivery" }],
    versions: [
      { number: 3, author: { kind: "person", personId: "anna" }, authorName: "Anna", itemKey: null, restoredFrom: 1, note: null, createdAt: 3_000 },
      { number: 2, author: { kind: "leader", agentId: "ag-lead", itemId: "item-42" }, authorName: "Review lead", itemKey: "EO-42", restoredFrom: null, note: null, createdAt: 2_000 },
      { number: 1, author: { kind: "assistant" }, authorName: null, itemKey: null, restoredFrom: null, note: null, createdAt: 1_000 },
    ],
    ...overrides,
  };
}

const SIGNED_OUT_CODEX: RuntimeStatusView = {
  id: "codex",
  label: "Codex",
  publisher: "OpenAI",
  termsUrl: "https://github.com/openai/codex/blob/main/LICENSE",
  source: "cache",
  path: "/home/x/.config/EO/runtimes/codex/codex",
  version: "0.147.0",
  packageName: "@openai/codex",
  packageVersion: "0.147.0-linux-x64",
  state: "ready",
  auth: { state: "signed_out", method: null, kind: "unknown", storedKey: false, account: null, problem: null },
};

type Call = { channel: string; payload: unknown };

function mockIpc(teams: () => TeamView[], answers: Record<string, unknown> = {}, runtime: (provider: string) => RuntimeStatusView | null = () => null): Call[] {
  const calls: Call[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel in answers) return { ok: true, data: answers[channel] };
    switch (channel) {
      case "teams:list":
        return { ok: true, data: { teams: teams() } };
      case "agents:listDetailed":
        return { ok: true, data: { agents: [] } };
      case "runtime:status":
        return { ok: true, data: { runtime: runtime((payload as { provider: string }).provider) } };
      case "registry:get":
        return { ok: true, data: registryView };
      case "policy:get":
        return { ok: true, data: { policy: NO_POLICY, fromServer: false, yours: null } };
      case "sections:list":
        return { ok: true, data: { published: [], locked: [], lockText: SECTION_LOCK_TEXT } };
      case "providers:capabilities": {
        const { provider } = payload as { provider: string };
        const models =
          provider === "codex"
            ? [{ value: "gpt-5.1-codex", label: "GPT-5.1 Codex", supportsEffort: true, effortLevels: ["low", "high", "xhigh"] }]
            : provider === "claude"
              ? [{ value: "claude-opus-5", label: "Opus 5", supportsEffort: true, effortLevels: ["low", "high"] }]
              : [];
        return { ok: true, data: { capabilities: { provider, models, modelsAreLive: true, reasoningEfforts: provider === "codex" ? ["low", "high", "xhigh"] : [] }, models, problem: null } };
      }
      default:
        return { ok: true, data: {} };
    }
  }) as never;
  return calls;
}

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

function mount(askAssistant: (() => void) | null = null) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/agents"]}>
        <ViewPublisher>
          <AskAssistantContext.Provider value={askAssistant}>
            <Routes>
              <Route path="/agents" element={<AgentsView />} />
              <Route path="*" element={<Where />} />
            </Routes>
          </AskAssistantContext.Provider>
        </ViewPublisher>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openTeams(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("tab", { name: "Teams" }));
  return screen.findByRole("region", { name: "EO reviewers" });
}

afterEach(() => setBridge(undefined));

describe("the Teams tab (EO-884)", () => {
  it("sits beside Agents and Runtimes", async () => {
    mockIpc(() => [team()]);
    mount();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent?.replace(/\d+$/, ""))).toEqual(["Agents", "Teams", "Runtimes"]);
  });

  it("lists every team, and shows one's coordination, leader, members, pool, range, limits, cap and steps", async () => {
    mockIpc(() => [team(), team({ id: "team-2", name: "Planners", coordination: "independent", leader: null, members: [member({ key: "scope", teamInstructions: "Check the scope." })], versions: [] })]);
    mount();
    const head = await openTeams();
    const list = screen.getByRole("list", { name: "Teams" });
    expect(within(list).getByRole("button", { name: /EO reviewers.*Led by Review lead · 2 members/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /Planners.*1 member/ })).toBeInTheDocument();
    expect(head).toHaveTextContent("Leader-led, with report-only members · Shop · version 3");

    const leader = within(screen.getByRole("region", { name: "Leader" })).getByRole("listitem", { name: "Leader Review lead" });
    expect(leader).toHaveTextContent("Split the review by risk.");
    expect(leader).toHaveTextContent("Lead reviews.");

    const members = screen.getByRole("region", { name: "Members" });
    expect(members).toHaveTextContent("2 of at most 6.");
    const tests = within(members).getByRole("listitem", { name: "Member Test expert" });
    expect(within(tests).getByText("reviewer")).toBeInTheDocument();
    expect(tests).toHaveTextContent("RuntimeCodex");
    expect(tests).toHaveTextContent("Modelgpt-5.1-codex");
    expect(tests).toHaveTextContent("Reasoning effortxhigh");
    expect(tests).toHaveTextContent("Find the tests that are missing.");
    expect(tests).toHaveTextContent("Added by the team's leader, on EO-42");
    expect(within(members).getByRole("listitem", { name: "Member Criteria expert" })).toHaveTextContent("Added when EO declared a team that already existed (from a step, an import or the record)");

    const pool = screen.getByRole("region", { name: "What it may use" });
    for (const text of ["CLI toolsgh", "MCP serversrepo", "Skillswrite-tests", "RuntimesClaude Code, Codex", "Modelsclaude-opus-5, gpt-5.1-codex", "Reasoninglow, high", "Member cap6", "Rounds2", "At once2"]) {
      expect(pool).toHaveTextContent(text);
    }
    expect(within(screen.getByRole("region", { name: "Used by" })).getByRole("link", { name: "Delivery · Review" })).toHaveAttribute("href", "/pipelines/pl-1");

    // Another team, picked from the list.
    fireEvent.click(within(list).getByRole("button", { name: /Planners/ }));
    const planners = await screen.findByRole("region", { name: "Planners" });
    expect(planners).toHaveTextContent("Independent, with report-only members");
    expect(within(screen.getByRole("region", { name: "Members" })).getByRole("listitem", { name: "Member Criteria expert" })).toHaveTextContent("Check the scope.");
  });

  it("says who made each version, links a leader's to its item, and restores one", async () => {
    let restored = false;
    const calls = mockIpc(() => [team({ version: restored ? 4 : 3 })]);
    const base = window.eo.ipc.invoke;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "teams:restore") {
        calls.push({ channel, payload });
        restored = true;
        return { ok: true, data: { restored: true, problem: null } };
      }
      return base(channel as never, payload as never);
    }) as never;
    mount();
    await openTeams();
    const versions = screen.getByRole("list", { name: "Versions" });
    expect(within(versions).getByRole("listitem", { name: "Version 3" })).toHaveTextContent(/Anna.*restored v1.*current/);
    expect(within(versions).getByRole("listitem", { name: "Version 1" })).toHaveTextContent("The assistant, in a draft a person published");
    const byLeader = within(versions).getByRole("listitem", { name: "Version 2" });
    expect(byLeader).toHaveTextContent("Review lead, leading on EO-42");

    // The current version is not offered back to itself.
    expect(within(within(versions).getByRole("listitem", { name: "Version 3" })).queryByRole("button", { name: "Restore" })).toBeNull();
    fireEvent.click(within(byLeader).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls.filter((call) => call.channel === "teams:restore").map((call) => call.payload)).toEqual([{ teamId: "team-1", version: 2 }]));
    await waitFor(() => expect(screen.getByRole("region", { name: "EO reviewers" })).toHaveTextContent("version 4"));

    fireEvent.click(within(byLeader).getByRole("link", { name: "EO-42" }));
    expect(await screen.findByTestId("where")).toHaveTextContent("/items/item-42");
  });

  it("locks and unlocks a team, and offers no restore while it is locked", async () => {
    let locked = false;
    const calls = mockIpc(() => [team({ locked })]);
    const base = window.eo.ipc.invoke;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "teams:setLocked") {
        calls.push({ channel, payload });
        locked = (payload as { locked: boolean }).locked;
        return { ok: true, data: { changed: true, problem: null } };
      }
      return base(channel as never, payload as never);
    }) as never;
    mount();
    const head = await openTeams();
    expect(within(screen.getByRole("list", { name: "Versions" })).getAllByRole("button", { name: "Restore" })).toHaveLength(2);

    fireEvent.click(within(head).getByRole("button", { name: "Lock" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "EO reviewers" })).getByText("Locked")).toBeInTheDocument());
    expect(within(screen.getByRole("list", { name: "Versions" })).queryAllByRole("button", { name: "Restore" })).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Versions" })).toHaveTextContent("Unlock the team to restore one.");

    fireEvent.click(within(screen.getByRole("region", { name: "EO reviewers" })).getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Versions" })).getAllByRole("button", { name: "Restore" })).toHaveLength(2));
    expect(calls.filter((call) => call.channel === "teams:setLocked").map((call) => call.payload)).toEqual([
      { teamId: "team-1", locked: true },
      { teamId: "team-1", locked: false },
    ]);
  });

  it("offers nothing that edits instructions or membership, and links to the assistant to change them", async () => {
    mockIpc(() => [team()]);
    const askAssistant = vi.fn();
    mount(askAssistant);
    await openTeams();
    const panel = screen.getByRole("region", { name: "Members" }).parentElement as HTMLElement;
    expect(within(panel).queryAllByRole("textbox")).toHaveLength(0);
    // Deleting the whole team (EO-897) is not a change to its membership.
    const teamDelete = within(screen.getByRole("region", { name: "EO reviewers" })).getByRole("button", { name: "Delete" });
    expect(within(panel).queryAllByRole("button", { name: /add|remove|delete|edit/i }).filter((button) => button !== teamDelete)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Change members or instructions with the assistant" }));
    expect(askAssistant).toHaveBeenCalledTimes(1);
  });

  it("shows each member's whole instructions, read-only, not only their first line", async () => {
    const instructions = "# Criteria pass\n\nHold the change to every acceptance criterion.\n\nThen check the edge cases the story names, one by one.";
    mockIpc(() => [team({ members: [member({ instructions })] })]);
    mount();
    await openTeams();
    const card = within(screen.getByRole("region", { name: "Members" })).getByRole("listitem", { name: "Member Criteria expert" });
    expect(within(card).getByText("Hold the change to every acceptance criterion.", { exact: false, selector: "summary" })).toBeInTheDocument();
    const whole = within(card).getByLabelText("Criteria expert's instructions");
    expect(whole).toHaveTextContent("Then check the edge cases the story names, one by one.");
    expect(whole.tagName).toBe("P");
    expect(within(card).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("says in a whole sentence that EO declared a team that already existed, on its version and its members", async () => {
    mockIpc(() => [team({ versions: [{ number: 1, author: { kind: "eo" }, authorName: null, itemKey: null, restoredFrom: null, note: null, createdAt: 1_000 }] })]);
    mount();
    await openTeams();
    expect(within(screen.getByRole("list", { name: "Versions" })).getByText("EO, declaring a team that already existed (from a step, an import or the record)")).toBeInTheDocument();
    const card = within(screen.getByRole("region", { name: "Members" })).getByRole("listitem", { name: "Member Criteria expert" });
    expect(within(card).getByText("Added when EO declared a team that already existed (from a step, an import or the record)")).toBeInTheDocument();
  });

  it("shows the sentence a version by EO says why it was made with, beside EO, not that EO declared the team (EO-899)", async () => {
    const note = 'EO moved this team into the project "Acme", which the pipeline "Delivery" that runs as it belongs to: it belonged to no project, and a step may run only as a team of its own pipeline\'s project.';
    mockIpc(() => [
      team({
        version: 2,
        versions: [
          { number: 2, author: { kind: "eo" }, authorName: null, itemKey: null, restoredFrom: null, note, createdAt: 2_000 },
          { number: 1, author: { kind: "eo" }, authorName: null, itemKey: null, restoredFrom: null, note: null, createdAt: 1_000 },
        ],
      }),
    ]);
    mount();
    await openTeams();
    const versions = screen.getByRole("list", { name: "Versions" });
    const moved = within(versions).getByRole("listitem", { name: "Version 2" });
    expect(within(moved).getByText(note)).toBeInTheDocument();
    expect(moved).not.toHaveTextContent("declaring a team that already existed");
    expect(within(versions).getByRole("listitem", { name: "Version 1" })).toHaveTextContent("EO, declaring a team that already existed");
  });

  it("says a version was EO's system agent's or an outside client's, set through EO's tools (EO-900)", async () => {
    mockIpc(() => [
      team({
        versions: [
          { number: 3, author: { kind: "client" }, authorName: null, itemKey: null, restoredFrom: null, note: null, createdAt: 3_000 },
          { number: 2, author: { kind: "system", agentId: "ag-system" }, authorName: "Assistant", itemKey: null, restoredFrom: null, note: null, createdAt: 2_000 },
          { number: 1, author: { kind: "eo" }, authorName: null, itemKey: null, restoredFrom: null, note: null, createdAt: 1_000 },
        ],
      }),
    ]);
    mount();
    await openTeams();
    const versions = screen.getByRole("list", { name: "Versions" });
    expect(within(versions).getByRole("listitem", { name: "Version 3" })).toHaveTextContent("An outside client, over EO's MCP server");
    expect(within(versions).getByRole("listitem", { name: "Version 2" })).toHaveTextContent("Assistant, EO's system agent");
  });

  it("says where a member's runtime is shown that this machine is not signed in to its backend", async () => {
    mockIpc(() => [team()], {}, (provider) => (provider === "codex" ? SIGNED_OUT_CODEX : null));
    mount();
    await openTeams();
    const members = screen.getByRole("region", { name: "Members" });
    expect(await within(within(members).getByRole("listitem", { name: "Member Test expert" })).findByRole("note")).toHaveTextContent("This machine is not signed in to Codex");
    expect(within(within(members).getByRole("listitem", { name: "Member Criteria expert" })).queryByRole("note")).toBeNull();
  });

  it("publishes the team it shows, so the assistant knows which team is meant", async () => {
    const calls = mockIpc(() => [team()]);
    mount();
    await openTeams();
    await waitFor(() => {
      const published = calls.filter((call) => call.channel === "view:publish").at(-1)?.payload as { selection?: string[] } | undefined;
      expect(published?.selection).toEqual(["team-1"]);
    });
  });

  it("says when no team is declared yet", async () => {
    mockIpc(() => []);
    mount();
    fireEvent.click(await screen.findByRole("tab", { name: "Teams" }));
    expect(await screen.findByText("No team is declared yet.")).toBeInTheDocument();
  });

  it("changes a member's runtime, model and reasoning — the leader's included — as a new version", async () => {
    let saved = false;
    const calls = mockIpc(() => [team(saved ? { version: 4, leader: member({ agentId: "ag-lead", name: "Review lead", provider: "codex", model: "gpt-5.1-codex", reasoning: "xhigh", teamInstructions: "Split the review by risk." }) } : {})]);
    const base = window.eo.ipc.invoke;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "teams:setMemberSettings") {
        calls.push({ channel, payload });
        saved = true;
        return { ok: true, data: { saved: true, problem: null } };
      }
      return base(channel as never, payload as never);
    }) as never;
    mount();
    await openTeams();
    const leader = within(screen.getByRole("region", { name: "Leader" })).getByRole("listitem", { name: "Leader Review lead" });
    fireEvent.click(within(leader).getByRole("button", { name: "Change runtime, model or reasoning" }));
    const editor = within(leader).getByRole("group", { name: "Review lead's runtime, model and reasoning" });
    fireEvent.change(within(editor).getByRole("combobox", { name: "Runtime" }), { target: { value: "codex" } });
    await waitFor(() => expect(within(editor).getByRole("option", { name: "GPT-5.1 Codex" })).toBeInTheDocument());
    fireEvent.change(within(editor).getByRole("combobox", { name: "Model" }), { target: { value: "gpt-5.1-codex" } });
    fireEvent.change(within(editor).getByRole("combobox", { name: "Reasoning effort" }), { target: { value: "xhigh" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save as a new version" }));

    await waitFor(() =>
      expect(calls.filter((call) => call.channel === "teams:setMemberSettings").map((call) => call.payload)).toEqual([
        { teamId: "team-1", agentId: "ag-lead", provider: "codex", model: "gpt-5.1-codex", reasoning: "xhigh" },
      ]),
    );
    await waitFor(() => expect(screen.getByRole("region", { name: "EO reviewers" })).toHaveTextContent("version 4"));
    const after = within(screen.getByRole("region", { name: "Leader" })).getByRole("listitem", { name: "Leader Review lead" });
    expect(within(after).queryByRole("group", { name: "Review lead's runtime, model and reasoning" })).toBeNull();
    expect(after).toHaveTextContent("RuntimeCodex");
    expect(after).toHaveTextContent("Reasoning effortxhigh");
  });

  it("says in the runtime picker, and under it, that this machine is not signed in to a backend", async () => {
    mockIpc(() => [team()], {}, (provider) => (provider === "codex" ? SIGNED_OUT_CODEX : null));
    mount();
    await openTeams();
    const criteria = within(screen.getByRole("region", { name: "Members" })).getByRole("listitem", { name: "Member Criteria expert" });
    fireEvent.click(within(criteria).getByRole("button", { name: "Change runtime, model or reasoning" }));
    const editor = within(criteria).getByRole("group", { name: "Criteria expert's runtime, model and reasoning" });
    await waitFor(() => expect(within(editor).getByRole("option", { name: "Codex — not signed in on this machine" })).toBeInTheDocument());
    expect(within(editor).queryByRole("note")).toBeNull();
    fireEvent.change(within(editor).getByRole("combobox", { name: "Runtime" }), { target: { value: "codex" } });
    expect(within(editor).getByRole("note")).toHaveTextContent("This machine is not signed in to Codex");
  });

  it("offers no change to a member of a locked team, and no restore where the organisation manages the pipelines", async () => {
    mockIpc(() => [team({ locked: true })]);
    mount();
    await openTeams();
    expect(screen.queryAllByRole("button", { name: "Change runtime, model or reasoning" })).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Members" })).toHaveTextContent("Unlock the team to change a member's runtime, model or reasoning.");
    cleanup();

    mockIpc(() => [team()], {
      "sections:list": {
        published: [{ section: "pipelines", subjectId: "", versionId: null, versionNumber: null, publishedAt: 1, publishedBy: "dana-id", publishedByName: "Dana", document: null }],
        locked: ["pipelines"],
        lockText: SECTION_LOCK_TEXT,
      },
    });
    mount();
    await openTeams();
    await waitFor(() => expect(screen.getByRole("region", { name: "Versions" })).toHaveTextContent("Your organisation manages the pipelines"));
    expect(within(screen.getByRole("list", { name: "Versions" })).queryAllByRole("button", { name: "Restore" })).toHaveLength(0);
    // Unlocking would let the team change by another door, so the lock is held too.
    const head = screen.getByRole("region", { name: "EO reviewers" });
    expect(within(head).queryByRole("button", { name: /^(Lock|Unlock)$/ })).toBeNull();
    expect(head).toHaveTextContent("the team can't be locked or unlocked here");
    // A member's runtime stays the person's.
    expect(screen.getAllByRole("button", { name: "Change runtime, model or reasoning" }).length).toBeGreaterThan(0);
  });
});

describe("changing several members at once (EO-901)", () => {
  /**
   * A Teams tab whose bulk change answers with `refusal`, or applies the
   * settings to the members asked for as version 4; a restore of version 4's
   * predecessor puts every member back as version 5.
   */
  function bulk(refusal: string | null = null): Call[] {
    let applied: { agentIds: string[]; provider: string; model: string | null; reasoning: string | null } | null = null;
    let restored = false;
    const shown = (): TeamView => {
      const base = team();
      if (applied === null || restored) return restored ? team({ version: 5 }) : base;
      const moved = applied;
      const change = (one: TeamMemberView): TeamMemberView => (moved.agentIds.includes(one.agentId) ? { ...one, provider: moved.provider, model: moved.model, reasoning: moved.reasoning } : one);
      return {
        ...base,
        version: 4,
        leader: base.leader === null ? null : change(base.leader),
        members: base.members.map(change),
        versions: [{ number: 4, author: { kind: "person", personId: "anna" }, authorName: "Anna", itemKey: null, restoredFrom: null, note: null, createdAt: 4_000 }, ...base.versions],
      };
    };
    const calls = mockIpc(() => [shown()]);
    const base = window.eo.ipc.invoke;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "teams:setMembersSettings") {
        calls.push({ channel, payload });
        if (refusal !== null) return { ok: true, data: { saved: false, changed: [], version: 3, problem: refusal, note: null } };
        applied = payload as typeof applied;
        return { ok: true, data: { saved: true, changed: ["Review lead"], version: 4, problem: null, note: null } };
      }
      if (channel === "teams:restore") {
        calls.push({ channel, payload });
        restored = true;
        return { ok: true, data: { restored: true, problem: null } };
      }
      return base(channel as never, payload as never);
    }) as never;
    return calls;
  }

  async function openBulk(): Promise<HTMLElement> {
    await openTeams();
    fireEvent.click(within(screen.getByRole("region", { name: "Several at once" })).getByRole("button", { name: "Change several members at once" }));
    return screen.getByRole("group", { name: "Several members' runtime, model and reasoning" });
  }

  async function chooseCodex(editor: HTMLElement) {
    fireEvent.change(within(editor).getByRole("combobox", { name: "Runtime" }), { target: { value: "codex" } });
    await waitFor(() => expect(within(editor).getByRole("option", { name: "GPT-5.1 Codex" })).toBeInTheDocument());
    fireEvent.change(within(editor).getByRole("combobox", { name: "Model" }), { target: { value: "gpt-5.1-codex" } });
    fireEvent.change(within(editor).getByRole("combobox", { name: "Reasoning effort" }), { target: { value: "low" } });
  }

  const applied = (calls: Call[]) => calls.filter((call) => call.channel === "teams:setMembersSettings").map((call) => call.payload);

  it("offers every member, the leader included, and applies to the ones selected — the rest unchanged", async () => {
    const calls = bulk();
    mount();
    const editor = await openBulk();
    const chosen = within(editor).getByRole("group", { name: "Members to apply it to" });
    expect(within(chosen).getAllByRole("checkbox").map((box) => box.parentElement?.textContent)).toEqual(["Select all", "Review lead (leader)", "Criteria expert", "Test expert"]);
    // Nothing is offered to apply until a member is chosen.
    expect(within(editor).getByRole("button", { name: "Apply" })).toBeDisabled();

    await chooseCodex(editor);
    fireEvent.click(within(chosen).getByRole("checkbox", { name: "Review lead (leader)" }));
    fireEvent.click(within(chosen).getByRole("checkbox", { name: "Criteria expert" }));
    expect(within(chosen).getByRole("checkbox", { name: "Select all" })).not.toBeChecked();
    fireEvent.click(within(editor).getByRole("button", { name: "Apply to 2 members" }));

    await waitFor(() => expect(applied(calls)).toEqual([{ teamId: "team-1", agentIds: ["ag-lead", "ag-criteria"], provider: "codex", model: "gpt-5.1-codex", reasoning: "low" }]));
    await waitFor(() => expect(screen.getByRole("region", { name: "EO reviewers" })).toHaveTextContent("version 4"));
    expect(screen.queryByRole("group", { name: "Several members' runtime, model and reasoning" })).toBeNull();
    const members = screen.getByRole("region", { name: "Members" });
    expect(within(members).getByRole("listitem", { name: "Member Criteria expert" })).toHaveTextContent("Reasoning effortlow");
    expect(within(members).getByRole("listitem", { name: "Member Test expert" })).toHaveTextContent("Reasoning effortxhigh");
    expect(within(screen.getByRole("region", { name: "Leader" })).getByRole("listitem", { name: "Leader Review lead" })).toHaveTextContent("RuntimeCodex");
  });

  it("selects every member with select all, and clears them with it again", async () => {
    const calls = bulk();
    mount();
    const editor = await openBulk();
    const chosen = within(editor).getByRole("group", { name: "Members to apply it to" });
    fireEvent.click(within(chosen).getByRole("checkbox", { name: "Select all" }));
    expect(within(chosen).getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(within(chosen).getByRole("checkbox", { name: "Select all" }));
    expect(within(chosen).getAllByRole("checkbox").some((box) => (box as HTMLInputElement).checked)).toBe(false);
    // Choosing each one by hand checks select all too.
    for (const name of ["Review lead (leader)", "Criteria expert", "Test expert"]) fireEvent.click(within(chosen).getByRole("checkbox", { name }));
    expect(within(chosen).getByRole("checkbox", { name: "Select all" })).toBeChecked();

    await chooseCodex(editor);
    fireEvent.click(within(editor).getByRole("button", { name: "Apply to 3 members" }));
    await waitFor(() => expect(applied(calls)).toEqual([{ teamId: "team-1", agentIds: ["ag-lead", "ag-criteria", "ag-tests"], provider: "codex", model: "gpt-5.1-codex", reasoning: "low" }]));
  });

  it("says a refusal as the sentence it came back as, and changes nothing", async () => {
    const refusal = 'The team "EO reviewers" is locked: a person must unlock it before it can change.';
    const calls = bulk(refusal);
    mount();
    const editor = await openBulk();
    fireEvent.click(within(editor).getByRole("checkbox", { name: "Select all" }));
    await chooseCodex(editor);
    fireEvent.click(within(editor).getByRole("button", { name: "Apply to 3 members" }));
    expect(await within(editor).findByText(refusal)).toBeInTheDocument();
    expect(applied(calls)).toHaveLength(1);
    // Still open, and the team as it was.
    expect(screen.getByRole("group", { name: "Several members' runtime, model and reasoning" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "EO reviewers" })).toHaveTextContent("version 3");
    expect(within(screen.getByRole("region", { name: "Members" })).getByRole("listitem", { name: "Member Criteria expert" })).toHaveTextContent("RuntimeClaude Code");
  });

  it("files one version, which one restore of the version before it undoes", async () => {
    const calls = bulk();
    mount();
    const editor = await openBulk();
    fireEvent.click(within(editor).getByRole("checkbox", { name: "Select all" }));
    await chooseCodex(editor);
    fireEvent.click(within(editor).getByRole("button", { name: "Apply to 3 members" }));
    const versions = await screen.findByRole("listitem", { name: "Version 4" });
    expect(versions).toHaveTextContent(/Anna.*current/);
    expect(within(screen.getByRole("list", { name: "Versions" })).getAllByRole("listitem")).toHaveLength(4);

    fireEvent.click(within(screen.getByRole("list", { name: "Versions" }).querySelector('[aria-label="Version 3"]') as HTMLElement).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls.filter((call) => call.channel === "teams:restore").map((call) => call.payload)).toEqual([{ teamId: "team-1", version: 3 }]));
    await waitFor(() => expect(screen.getByRole("region", { name: "EO reviewers" })).toHaveTextContent("version 5"));
    const members = screen.getByRole("region", { name: "Members" });
    expect(within(members).getByRole("listitem", { name: "Member Criteria expert" })).toHaveTextContent("RuntimeClaude Code");
    expect(within(screen.getByRole("region", { name: "Leader" })).getByRole("listitem", { name: "Leader Review lead" })).toHaveTextContent("Reasoning efforthigh");
  });

  it("says, as the one-member change does, that this machine is not signed in to the runtime chosen — and still applies", async () => {
    const calls = bulk();
    // A Codex this machine is signed out of, answered over the bulk mock's own.
    const base = window.eo.ipc.invoke;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "runtime:status" && (payload as { provider: string }).provider === "codex") return { ok: true, data: { runtime: SIGNED_OUT_CODEX } };
      return base(channel as never, payload as never);
    }) as never;
    mount();
    const editor = await openBulk();
    await waitFor(() => expect(within(editor).getByRole("option", { name: "Codex — not signed in on this machine" })).toBeInTheDocument());
    fireEvent.click(within(editor).getByRole("checkbox", { name: "Criteria expert" }));
    await chooseCodex(editor);
    expect(within(editor).getByRole("note")).toHaveTextContent("This machine is not signed in to Codex");
    fireEvent.click(within(editor).getByRole("button", { name: "Apply to 1 member" }));
    await waitFor(() => expect(applied(calls)).toEqual([{ teamId: "team-1", agentIds: ["ag-criteria"], provider: "codex", model: "gpt-5.1-codex", reasoning: "low" }]));
    await waitFor(() => expect(screen.getByRole("region", { name: "EO reviewers" })).toHaveTextContent("version 4"));
  });

  it("is not offered on a locked team, nor for an archived member", async () => {
    mockIpc(() => [team({ locked: true })]);
    mount();
    await openTeams();
    expect(screen.queryByRole("region", { name: "Several at once" })).toBeNull();
    cleanup();

    mockIpc(() => [team({ members: [member(), member({ agentId: "ag-old", name: "Old expert", archived: true })] })]);
    mount();
    const editor = await openBulk();
    expect(within(editor).queryByRole("checkbox", { name: "Old expert" })).toBeNull();
  });
});

describe("archiving or deleting a team from the Teams tab (EO-897)", () => {
  /** A Teams tab whose archive and delete answer as `answer` says; the team leaves the list once one is confirmed. */
  function removable(answer: (channel: "teams:archive" | "teams:delete", confirm: boolean) => { done: boolean; problem: string | null; members: string[] }): Call[] {
    let gone = false;
    const calls = mockIpc(() => (gone ? [team({ id: "team-2", name: "Planners" })] : [team(), team({ id: "team-2", name: "Planners" })]));
    const base = window.eo.ipc.invoke;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "teams:archive" || channel === "teams:delete") {
        calls.push({ channel, payload });
        const { confirm } = payload as { confirm: boolean };
        const said = answer(channel, confirm);
        if (said.done) gone = true;
        return { ok: true, data: channel === "teams:archive" ? { archived: said.done, problem: said.problem, members: said.members } : { deleted: said.done, problem: said.problem, members: said.members } };
      }
      return base(channel as never, payload as never);
    }) as never;
    return calls;
  }

  it("archives a team once the person confirms, naming its own agents that go with it, and the team leaves the tab", async () => {
    const calls = removable((_channel, confirm) => ({ done: confirm, problem: null, members: ["Review lead", "Criteria expert", "Test expert"] }));
    mount();
    const head = await openTeams();
    fireEvent.click(within(head).getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive EO reviewers?" });
    const going = await within(dialog).findByRole("generic", { name: "Agents that go with it" });
    expect(going).toHaveTextContent("Review lead");
    expect(going).toHaveTextContent("Test expert");
    // Nothing is archived until the person confirms.
    expect(calls.filter((call) => call.channel === "teams:archive").map((call) => call.payload)).toEqual([{ teamId: "team-1", confirm: false }]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Archive EO reviewers" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((call) => call.channel === "teams:archive").map((call) => call.payload)).toEqual([
      { teamId: "team-1", confirm: false },
      { teamId: "team-1", confirm: true },
    ]);
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Teams" })).queryByText("EO reviewers")).toBeNull());
  });

  it("deletes a team the same way", async () => {
    const calls = removable((_channel, confirm) => ({ done: confirm, problem: null, members: ["Review lead"] }));
    mount();
    const head = await openTeams();
    fireEvent.click(within(head).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete EO reviewers?" });
    expect(await within(dialog).findByText(/This cannot be undone/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete EO reviewers" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((call) => call.channel === "teams:delete").map((call) => call.payload)).toEqual([
      { teamId: "team-1", confirm: false },
      { teamId: "team-1", confirm: true },
    ]);
  });

  it("shows a refusal as the sentence it came back as, and offers nothing to confirm", async () => {
    const refusal = 'The team "EO reviewers" cannot be archived while "Review" on Delivery names it. Have "Review" on Delivery run as another team, or as none first, then archive it.';
    const calls = removable(() => ({ done: false, problem: refusal, members: [] }));
    mount();
    const head = await openTeams();
    fireEvent.click(within(head).getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive EO reviewers?" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(refusal);
    expect(within(dialog).queryByRole("button", { name: "Archive EO reviewers" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((call) => call.channel === "teams:archive").map((call) => call.payload)).toEqual([{ teamId: "team-1", confirm: false }]);
  });

  it("offers neither where the organisation manages the pipelines", async () => {
    mockIpc(() => [team()], {
      "sections:list": {
        published: [{ section: "pipelines", subjectId: "", versionId: null, versionNumber: null, publishedAt: 1, publishedBy: "dana-id", publishedByName: "Dana", document: null }],
        locked: ["pipelines"],
        lockText: SECTION_LOCK_TEXT,
      },
    });
    mount();
    await openTeams();
    await waitFor(() => expect(screen.getByRole("region", { name: "Versions" })).toHaveTextContent("Your organisation manages the pipelines"));
    const head = screen.getByRole("region", { name: "EO reviewers" });
    expect(within(head).queryByRole("button", { name: "Archive" })).toBeNull();
    expect(within(head).queryByRole("button", { name: "Delete" })).toBeNull();
  });
});
