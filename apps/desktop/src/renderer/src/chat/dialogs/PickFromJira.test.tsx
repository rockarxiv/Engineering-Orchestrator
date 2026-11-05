import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JiraIssueView } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../query/client";
import { PickFromJira } from "./PickFromJira";

function issue(overrides: Partial<JiraIssueView> = {}): JiraIssueView {
  return {
    id: "10001",
    key: "ACME-7",
    summary: "Rate limiting",
    description: "Throttle the public API.",
    issueType: "Epic",
    status: "To Do",
    parentKey: null,
    ...overrides,
  };
}

const CHILDREN = [
  issue({ id: "10002", key: "ACME-8", summary: "Count requests per key", issueType: "Story" }),
  issue({ id: "10003", key: "ACME-9", summary: "Return 429", issueType: "Story" }),
];

function repository(id: string, name: string, connected: boolean) {
  return {
    id,
    name,
    keyPrefix: name.toUpperCase(),
    repoPath: `/tmp/${name}`,
    baseBranch: "main",
    testCommand: null,
    lintCommand: null,
    buildCommand: null,
    itemCount: 0,
    forge: { openPr: false, kind: null, remote: "origin", draft: false, templatePath: null },
    jira: {
      baseUrl: connected ? "https://acme.atlassian.net" : null,
      flavour: connected ? "cloud" : null,
      projectKey: connected ? "ACME" : null,
      email: null,
      featureIssueType: "Epic",
      storyIssueType: "Story",
      fields: null,
      createByDefault: true,
      credentialsConfigured: connected,
    },
  };
}

function renderPicker({
  connected = true,
  issues = [issue()],
  children = [] as JiraIssueView[],
  existingItemId = null as string | null,
  /** The repositories the project spans. One, unless the case is about the choice (KAN-19). */
  repositoryIds = ["p1"],
} = {}) {
  const calls: { channel: string; payload: unknown }[] = [];
  const onImported = vi.fn();

  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "projects:list") {
      // One repository unless a case says otherwise — what every project was
      // before KAN-17, and what most of these cases are about.
      return { ok: true, data: { projects: [{ id: "b1", name: "repo", keyPrefix: "EO", jiraProjectId: "p1", repositoryIds, itemCount: 0 }], activeProjectId: "b1" } };
    }

    if (channel === "repositories:list") {
      return { ok: true, data: { repositories: repositoryIds.map((id, index) => repository(id, index === 0 ? "acme-api" : `acme-${index}`, connected)) } };
    }
    if (channel === "jira:search") return { ok: true, data: { issues, problem: null } };
    if (channel === "jira:preview") return { ok: true, data: { issue: issues[0], children, existingItemId, problem: null } };
    if (channel === "jira:import") return { ok: true, data: { itemId: "t-new", storyCount: children.length, alreadyImported: false, problem: null } };
    return { ok: true, data: {} };
  }) as never;

  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={createQueryClient()}>
      <PickFromJira open onOpenChange={onOpenChange} onImported={onImported} />
    </QueryClientProvider>,
  );

  return { calls, onImported, onOpenChange };
}

/**
 * Search and pick the first result.
 *
 * No opening click: the picker is controlled now — the top bar's New task
 * caret owns the ways to add work, so this had a trigger of its own only
 * while it was the only way in.
 */
async function pickFirst() {
  fireEvent.click(await screen.findByRole("button", { name: "Search" }));
  fireEvent.click(await screen.findByRole("button", { name: /ACME-7/ }));
}

/**
 * The chat layout's picker, held to the classic one's suite
 * (`pipeline/PickFromJira.test.tsx`) — the same IPC and the same
 * questions — and to what being this layout's dialog adds.
 */
describe("picking a feature from Jira (J-02)", () => {
  it("is not there at all when no repository is connected", async () => {
    // The integration is optional, and an action that can only fail is
    // worse than no action.
    renderPicker({ connected: false });

    // Nothing at all: not a panel, not an empty state.
    await waitFor(() => expect(screen.queryByLabelText("Pick from Jira")).not.toBeInTheDocument());
  });

  it("searches the connected repository and lists what came back", async () => {
    const { calls } = renderPicker();

    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "rate" } });
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));

    expect(await screen.findByText("Rate limiting")).toBeInTheDocument();
    expect(calls.find((call) => call.channel === "jira:search")?.payload).toEqual({ repositoryId: "p1", query: "rate" });
  });

  it("takes an issue with no children as work already written", async () => {
    const { calls, onImported } = renderPicker();

    await pickFirst();
    fireEvent.click(await screen.findByRole("button", { name: "Work it as written" }));

    await waitFor(() => expect(onImported).toHaveBeenCalledWith("t-new"));
    expect(calls.find((call) => call.channel === "jira:import")?.payload).toEqual({ repositoryId: "p1", key: "ACME-7", mode: "asWritten", targetProjectId: "p1" });
  });

  it("offers to plan a childless issue instead, for a request rather than an item", async () => {
    // Both readings are live for the same issue and neither is visible
    // from Jira's type, so both are on offer (KAN-19).
    const { calls } = renderPicker();

    await pickFirst();
    fireEvent.click(await screen.findByRole("button", { name: "Let EO plan it" }));

    await waitFor(() => {
      expect(calls.find((call) => call.channel === "jira:import")?.payload).toEqual({ repositoryId: "p1", key: "ACME-7", mode: "plan", targetProjectId: "p1" });
    });
  });

  it("asks the same question of a bug or a task as of a story", async () => {
    // The Jira issue type says nothing about whether the words in it are
    // finished work — plenty of teams write theirs as Bugs or Chores.
    renderPicker({ issues: [issue({ issueType: "Bug" })] });

    await pickFirst();

    expect(await screen.findByRole("button", { name: "Work it as written" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Let EO plan it" })).toBeInTheDocument();
  });

  it("asks which repository the work happens in, when the project spans several", async () => {
    // KAN-19: the connected repository is where the Jira credentials live,
    // which says nothing about where the code goes. Getting it wrong
    // sends the worktree, the branch and the pull request elsewhere.
    const { calls } = renderPicker({ repositoryIds: ["p1", "p2"] });

    await pickFirst();
    fireEvent.change(await screen.findByLabelText("Repository"), { target: { value: "p2" } });
    fireEvent.click(screen.getByRole("button", { name: "Work it as written" }));

    await waitFor(() => {
      expect(calls.find((call) => call.channel === "jira:import")?.payload).toMatchObject({ targetProjectId: "p2" });
    });
  });

  it("does not ask when there is only one repository to choose", async () => {
    renderPicker();

    await pickFirst();

    expect(await screen.findByRole("button", { name: "Work it as written" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Repository")).not.toBeInTheDocument();
  });

  it("asks about existing children rather than deciding for you", async () => {
    // Whether the plan in Jira is the plan to work is a judgement EO
    // cannot make, so it is asked every time.
    renderPicker({ children: CHILDREN });

    await pickFirst();

    expect(await screen.findByText(/has 2 children in Jira/)).toBeInTheDocument();
    expect(screen.getByText("ACME-8")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import them as stories" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Let EO plan it" })).toBeInTheDocument();
  });

  it("does not say \"it as stories\" about a single child", async () => {
    // Which a real Jira, whose epics had one subtask each, put on screen.
    renderPicker({ children: [CHILDREN[0]!] });

    await pickFirst();

    expect(await screen.findByRole("button", { name: "Import it as a story" })).toBeInTheDocument();
    expect(screen.getByText(/has 1 child in Jira/)).toBeInTheDocument();
  });

  it("carries the answer through to the import", async () => {
    const { calls } = renderPicker({ children: CHILDREN });

    await pickFirst();
    fireEvent.click(await screen.findByRole("button", { name: "Import them as stories" }));

    await waitFor(() => {
      expect(calls.find((call) => call.channel === "jira:import")?.payload).toEqual({ repositoryId: "p1", key: "ACME-7", mode: "children", targetProjectId: "p1" });
    });
  });

  it("says either answer leaves Jira alone, because that is the worry", async () => {
    renderPicker({ children: CHILDREN });

    await pickFirst();

    expect(await screen.findByText("Either way, nothing in Jira changes.")).toBeInTheDocument();
  });

  it("offers to open an issue EO already has instead of importing it twice", async () => {
    const { calls, onImported } = renderPicker({ existingItemId: "t-existing" });

    await pickFirst();
    fireEvent.click(await screen.findByRole("button", { name: "Open it" }));

    expect(onImported).toHaveBeenCalledWith("t-existing");
    expect(calls.some((call) => call.channel === "jira:import")).toBe(false);
  });

  it("shows an empty search as an answer rather than a blank panel", async () => {
    renderPicker({ issues: [] });

    fireEvent.click(await screen.findByRole("button", { name: "Search" }));

    expect(await screen.findByText("Nothing in ACME matched.")).toBeInTheDocument();
  });

  it("keeps the search scoped to one repository, and says so", async () => {
    renderPicker();

    expect(within(await screen.findByLabelText("Pick from Jira")).getByText(/Searches ACME only/)).toBeInTheDocument();
  });

  it("is a dialog that searches on Enter and closes on Escape", async () => {
    const { calls, onOpenChange } = renderPicker();

    const dialog = await screen.findByRole("dialog", { name: "Pick from Jira" });
    const box = within(dialog).getByRole("textbox", { name: "Words to look for" });
    await waitFor(() => expect(box).toHaveFocus());
    fireEvent.change(box, { target: { value: "ACME-7" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(calls.find((call) => call.channel === "jira:search")?.payload).toEqual({ repositoryId: "p1", query: "ACME-7" }));

    fireEvent.keyDown(box, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("goes back from a picked issue to the results", async () => {
    renderPicker();

    await pickFirst();
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));

    expect(await screen.findByRole("button", { name: /ACME-7/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Work it as written" })).not.toBeInTheDocument();
  });

  it("closes once the import has landed", async () => {
    const { onOpenChange } = renderPicker();

    await pickFirst();
    fireEvent.click(await screen.findByRole("button", { name: "Work it as written" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
