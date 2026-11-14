import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_GIT_STATE, developerRegistry, toRegistryView, type CommentView, type ItemPage as ItemDetailData, type RunView, type TransitionView } from "@eo/core";
import { COLLAPSED_HEIGHT_PX, ThemeProvider } from "@eo/ui";
import { AdminAuthorityProvider } from "../../../shared/admin/authority";
import { setBridge } from "../../../ipc/bridge";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { createQueryClient } from "../../../query/client";
import { itemsKey } from "../../../query/hooks";
import { useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { ViewPublisher } from "../../../shared/view/ViewPublisher";
import { BoardView } from "../board/BoardView";
import { ItemView } from "./ItemView";

/**
 * The chat layout's item view, held to what the classic item page does
 * (`item/ItemDetail.test.tsx` is the model): every action, refusal and
 * confirmation that page has, in this view's own drawing.
 */

function CurrentRoute() {
  return <div data-testid="current-route">{useLocation().pathname}</div>;
}

function comment(overrides: Partial<CommentView> = {}): CommentView {
  return {
    id: "c1",
    authorType: "agent",
    authorName: "Implementer",
    authorRole: "implementer",
    runId: null,
    parentId: null,
    canApprove: false,
    body: "Working on it.",
    kind: "note",
    options: null,
    pinned: false,
    createdAt: 100,
    awaitingHuman: false,
    mirroredInJira: false,
    ...overrides,
  };
}

function transition(overrides: Partial<TransitionView> = {}): TransitionView {
  return { id: "x1", fromStepId: "todo", toStepId: "review", actor: "human", reason: null, ts: 200, ...overrides };
}

function detail(overrides: Partial<ItemDetailData> = {}): ItemDetailData {
  return {
    item: {
      id: "t1",
      key: "EO-1",
      type: "story",
      typeLabel: "Story",
      container: false,
      parentId: null,
      parentKey: null,
      parentTitle: null,
      repositoryId: "p1",
      repositoryName: "repo",
      projectId: "b1",
      title: "Rate limit the API",
      pipelineId: "default",
      stepId: "todo",
      pipelineVersion: null,
      stepName: "To Do",
      progress: null,
      priority: 0,
      git: NO_GIT_STATE,
      workspace: { kind: "git-worktree", mode: "isolated", label: null },
      jiraKey: null,
      jiraUrl: null,
      jiraSync: true,
      jiraConnected: true,
      reference: null,
      reviewers: null,
      updatedAt: 1,
      stepEnteredAt: 1,
      heldAt: null,
      needsAttention: false,
      atTerminalStep: false,
      openDependencyCount: 0,
      openDependencyGates: [],
      dispatchHold: null,
      latestRunStatus: null,
      assigneeName: null,
      assigneePerson: null,
      claimable: false,
      preview: false,
      body: "Throttle the **public** API.",
      acceptanceCriteria: ["429 after 100 req/min"],
      typeKey: "developer:story",
      spec: { acceptance_criteria: ["429 after 100 req/min"] },
      origin: null,
      createdAt: 1,
      attachments: [],
      contentRefusal: null,
    },
    comments: [],
    transitions: [],
    runs: [],
    dependsOn: [],
    watch: null,
    decision: [],
    currentOutput: null,
    earlierComments: 0,
    ...overrides,
  };
}

const AGENTS = [{ id: "a1", name: "Implementer", role: "implementer", provider: "fake", model: null, enabled: true, archivedAt: null }];

const PIPELINE_STEPS = [
  { id: "todo", pipelineId: "default", position: 0, name: "To Do", type: "agent", ownerRole: "implementer", entryAction: "implement", instructionsSummary: null, isTerminal: false },
  { id: "review", pipelineId: "default", position: 1, name: "Review", type: "agent", ownerRole: "reviewer", entryAction: "review", instructionsSummary: null, isTerminal: false },
  { id: "ready_to_merge", pipelineId: "default", position: 2, name: "Merge Request", type: "builtin", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true },
];

function liveRun(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "r1",
    agentId: "a1",
    agentName: "Implementer",
    action: "implement",
    actionName: overrides.action ?? "implement",
    status: "running",
    attempt: 1,
    threadId: null,
    error: null,
    tokensIn: null,
    tokensOut: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    turns: null,
    turnsScope: null,
    costCents: null,
    startedAt: 1,
    endedAt: null,
    verificationOk: null,
    checks: [],
    steerable: true,
    ...overrides,
  };
}

type Calls = { channel: string; payload: unknown }[];

function mockIpc(data: ItemDetailData, onCall?: (channel: string, payload: unknown) => void, replies: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    onCall?.(channel, payload);
    if (channel in replies) {
      const reply = replies[channel];
      return { ok: true, data: typeof reply === "function" ? (reply as (payload: unknown) => unknown)(payload) : reply };
    }
    if (channel === "items:get") return { ok: true, data: { ...data, item: { ...data.item } } };
    // The registry as EO ships it, so the chrome says "ticket" as a developer project does.
    if (channel === "registry:get") return { ok: true, data: toRegistryView(developerRegistry()) };
    if (channel === "items:list") return { ok: true, data: { items: [data.item, ...data.dependsOn.map(({ id, key, title }) => ({ id, key, title }))] } };
    if (channel === "items:listArchived") return { ok: true, data: { items: [] } };
    if (channel === "agents:list") return { ok: true, data: { agents: AGENTS } };
    if (channel === "pipelineSteps:list") return { ok: true, data: { steps: PIPELINE_STEPS, routes: [] } };
    if (channel === "pipelines:list") return { ok: true, data: { pipelines: [{ id: "default", projectId: "b1", name: "Delivery", icon: null, entryStepId: "todo", position: 0, archivedAt: null }] } };
    if (channel === "comments:post") return { ok: true, data: { commentId: "new", resumedRun: true, delivery: null } };
    if (channel === "comments:setPinned") return { ok: true, data: { pinned: true, found: true } };
    if (channel === "projects:list") {
      return { ok: true, data: { projects: [{ id: "b1", name: "repo", keyPrefix: "EO", jiraProjectId: "p1", repositoryIds: ["p1"], itemCount: 0 }], activeProjectId: "b1" } };
    }
    if (channel === "projects:setActive") return { ok: true, data: { activeProjectId: (payload as { id: string }).id } };
    return { ok: true, data: {} };
  });
  window.eo.ipc.invoke = invoke as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  return invoke;
}

function renderItem(data: ItemDetailData, onCall?: (channel: string, payload: unknown) => void, replies: Record<string, unknown> = {}, client = createQueryClient()) {
  const invoke = mockIpc(data, onCall, replies);
  const { unmount } = render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/items/t1"]}>
          <ItemReferenceProvider>
            <ItemView itemId="t1" />
          </ItemReferenceProvider>
          <CurrentRoute />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return Object.assign(invoke, { unmount });
}

function recorder(): { calls: Calls; onCall: (channel: string, payload: unknown) => void } {
  const calls: Calls = [];
  return { calls, onCall: (channel, payload) => calls.push({ channel, payload }) };
}

const payloadOf = (calls: Calls, channel: string) => calls.find((call) => call.channel === channel)?.payload;

describe("the item view", () => {
  it("draws the item as the page it is: title, key, step, and the body as markdown", async () => {
    renderItem(detail());

    expect(await screen.findByRole("heading", { name: "Rate limit the API" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Rate limit the API" })).toBeInTheDocument();
    expect(screen.getByText("public").tagName).toBe("STRONG");
    expect(screen.getAllByText("To Do").length).toBeGreaterThan(0);
    // The view is the full page: no way out to a classic one.
    expect(screen.queryByRole("link", { name: /full page/i })).not.toBeInTheDocument();
  });

  it("switches between the item and its runs, at the classic addresses", async () => {
    renderItem(detail({ runs: [liveRun()] }));

    const tabs = await screen.findByRole("tablist", { name: "Item or runs" });
    expect(within(tabs).getByRole("tab", { name: "Item" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(tabs).getByRole("tab", { name: /Runs/ }));
    await waitFor(() => expect(screen.getByTestId("current-route")).toHaveTextContent("/items/t1/runs"));
  });

  it("keeps the Jira key on its external destination", async () => {
    const data = detail();
    data.item.jiraKey = "ACME-7";
    data.item.jiraUrl = "https://acme.atlassian.net/browse/ACME-7";
    renderItem(data);

    expect(await screen.findByRole("link", { name: "ACME-7" })).toHaveAttribute("href", data.item.jiraUrl);
  });

  it("links keys in the criteria, and dependencies by their stable id", async () => {
    const data = detail({
      item: { ...detail().item, acceptanceCriteria: ["EO-9 must land before this"] },
      dependsOn: [
        { id: "d1", key: "EO-9", title: "Do this first", stepId: "todo", stepName: "Implementer", wait: "finished", waitStepId: null, waitStepName: null },
        { id: "other-project-item", key: "WEB-7", title: "Ship the web change", stepId: "todo", stepName: "Implementer", wait: "finished", waitStepId: null, waitStepName: null },
      ],
    });
    renderItem(data);

    const criteria = await screen.findByRole("region", { name: "Acceptance criteria" });
    expect(await within(criteria).findByRole("link", { name: "EO-9" })).toHaveAttribute("href", "/items/d1");
    const blocked = screen.getByRole("region", { name: "Dependencies" });
    expect(within(blocked).getByRole("link", { name: "WEB-7" })).toHaveAttribute("href", "/items/other-project-item");
  });

  it("says what releases the item from each dependency, as a replica pulled from the record reads it (EO-778)", async () => {
    // The `dependsOn` a replica's `items:get` answers once the record has
    // sent a gated edge (main/record/dependencyGates.test.ts): the rule and
    // the step by id and name, beside the step the dependency stands on now.
    renderItem(
      detail({
        dependsOn: [
          { id: "d1", key: "EO-12", title: "The parent", stepId: "worktree", stepName: "Worktree", wait: "reached", waitStepId: "review", waitStepName: "Review" },
          { id: "d2", key: "EO-13", title: "Lands first", stepId: "todo", stepName: "To Do", wait: "finished", waitStepId: null, waitStepName: null },
          { id: "d3", key: "WEB-7", title: "Another repository", stepId: "todo", stepName: "To Do", wait: "none", waitStepId: null, waitStepName: null },
          { id: "d4", key: "EO-14", title: "Its step is gone", stepId: "todo", stepName: "To Do", wait: "reached", waitStepId: "retired", waitStepName: null },
        ],
      }),
    );

    const dependencies = await screen.findByRole("region", { name: "Dependencies" });
    expect(within(dependencies).getByText("Depends on")).toBeInTheDocument();
    expect(within(dependencies).queryByText("Blocked by")).toBeNull();
    const row = (key: string) => within(dependencies).getByRole("link", { name: key }).closest("li") as HTMLElement;
    expect(within(row("EO-12")).getByText("Until it reaches Review")).toBeInTheDocument();
    expect(within(row("EO-12")).getByText("Worktree")).toBeInTheDocument();
    expect(within(row("EO-13")).getByText("Until it finishes")).toBeInTheDocument();
    expect(within(row("WEB-7")).getByText("Doesn't wait")).toBeInTheDocument();
    expect(within(row("EO-14")).getByText("Until it reaches a step that no longer exists")).toBeInTheDocument();
  });

  it("says why a pack holds the item on its step, beside the step (EO-781)", async () => {
    const base = detail();
    renderItem(detail({ item: { ...base.item, stepId: "merge_request", stepName: "Merge request", dispatchHold: "Waits for EO-12 to open its pull request" } }));

    expect(await screen.findByText("Waits for EO-12 to open its pull request")).toBeInTheDocument();
  });

  describe("a dependency's wait rule (EO-779)", () => {
    // What `items:waitSteps` answers for the dependency: its own
    // pipeline's steps, the off-board Discussion among them and the
    // terminal one left out (main's `listWaitSteps` holds that).
    const WAIT_STEPS = [
      { id: "discussion", name: "Discussion" },
      { id: "build", name: "Build" },
      { id: "watch", name: "Watch merge request" },
    ];
    type Dependency = ItemDetailData["dependsOn"][number];
    const dependency = (overrides: Partial<Dependency> = {}): Dependency => ({
      id: "d1",
      key: "EO-12",
      title: "Do this first",
      stepId: "build",
      stepName: "Build",
      wait: "finished",
      waitStepId: null,
      waitStepName: null,
      ...overrides,
    });
    const waitSteps = (payload: unknown) => ({ steps: (payload as { itemId: string }).itemId === "d1" ? WAIT_STEPS : [] });

    /** An item page whose dependency takes whatever rule `items:update` was last sent, as the main process would. */
    function renderLive(start: Dependency, refuse: string | null = null) {
      let current = detail({ dependsOn: [start] });
      const { calls, onCall } = recorder();
      renderItem(current, onCall, {
        "items:get": () => current,
        "items:waitSteps": waitSteps,
        "items:update": (payload: unknown) => {
          if (refuse !== null) return { updated: false, problem: refuse };
          const [change] = (payload as { updateDependsOn: { wait: Dependency["wait"]; step?: string }[] }).updateDependsOn;
          const step = WAIT_STEPS.find((each) => each.id === change!.step) ?? null;
          current = { ...current, dependsOn: [{ ...start, wait: change!.wait, waitStepId: step?.id ?? null, waitStepName: step?.name ?? null }] };
          return { updated: true, problem: null };
        },
      });
      return calls;
    }

    const region = () => screen.findByRole("region", { name: "Dependencies" });

    it("says each dependency's rule in words", async () => {
      renderItem(
        detail({
          dependsOn: [
            dependency(),
            dependency({ id: "d2", key: "EO-13", wait: "reached", waitStepId: "watch", waitStepName: "Watch merge request" }),
            dependency({ id: "d3", key: "EO-14", wait: "none" }),
          ],
        }),
      );

      const blocked = await region();
      expect(within(blocked).getByText("Until it finishes")).toBeInTheDocument();
      expect(within(blocked).getByText("Until it reaches Watch merge request")).toBeInTheDocument();
      expect(within(blocked).getByText("Doesn't wait")).toBeInTheDocument();
    });

    it("changes a rule to reach a step of the dependency's own pipeline, as the save would judge it", async () => {
      const calls = renderLive(dependency());

      fireEvent.click(within(await region()).getByRole("button", { name: "Change how this waits for EO-12" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Wait for EO-12" }), { target: { value: "reached" } });
      const picker = screen.getByRole("combobox", { name: "Step of EO-12 to wait for" });
      await waitFor(() => expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual(["Choose a step…", "Discussion", "Build", "Watch merge request"]));
      // Asked about the dependency, whose pipeline the save reads.
      expect(payloadOf(calls, "items:waitSteps")).toEqual({ itemId: "d1" });
      fireEvent.change(picker, { target: { value: "watch" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", updateDependsOn: [{ item: "d1", wait: "reached", step: "watch" }] }));
      expect(await within(await region()).findByText("Until it reaches Watch merge request")).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "Wait for EO-12" })).not.toBeInTheDocument();
    });

    it("changes a rule to not waiting, and back to waiting until it finishes", async () => {
      const calls = renderLive(dependency({ wait: "reached", waitStepId: "watch", waitStepName: "Watch merge request" }));

      fireEvent.click(within(await region()).getByRole("button", { name: "Change how this waits for EO-12" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Wait for EO-12" }), { target: { value: "none" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", updateDependsOn: [{ item: "d1", wait: "none" }] }));
      expect(await within(await region()).findByText("Doesn't wait")).toBeInTheDocument();

      fireEvent.click(within(await region()).getByRole("button", { name: "Change how this waits for EO-12" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Wait for EO-12" }), { target: { value: "finished" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls.filter((call) => call.channel === "items:update").at(-1)?.payload).toEqual({ itemId: "t1", updateDependsOn: [{ item: "d1", wait: "finished" }] }));
      expect(await within(await region()).findByText("Until it finishes")).toBeInTheDocument();
    });

    it("says a refusal under the row and keeps the rule it had", async () => {
      renderLive(dependency(), "EO-1 is being worked on right now, so its content cannot change under the agent holding it.");

      fireEvent.click(within(await region()).getByRole("button", { name: "Change how this waits for EO-12" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Wait for EO-12" }), { target: { value: "none" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(await within(await region()).findByRole("alert")).toHaveTextContent("is being worked on right now");
      expect(within(await region()).getByText("Until it finishes")).toBeInTheDocument();
    });

    it("waits for a step the board draws no column for", async () => {
      const calls = renderLive(dependency());

      fireEvent.click(within(await region()).getByRole("button", { name: "Change how this waits for EO-12" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Wait for EO-12" }), { target: { value: "reached" } });
      const picker = screen.getByRole("combobox", { name: "Step of EO-12 to wait for" });
      await within(picker).findByRole("option", { name: "Discussion" });
      fireEvent.change(picker, { target: { value: "discussion" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", updateDependsOn: [{ item: "d1", wait: "reached", step: "discussion" }] }));
      expect(await within(await region()).findByText("Until it reaches Discussion")).toBeInTheDocument();
    });

    it("closes an open editor when the item stops being changeable", async () => {
      let current = detail({ dependsOn: [dependency()] });
      const client = createQueryClient();
      renderItem(current, undefined, { "items:get": () => current, "items:waitSteps": waitSteps }, client);

      fireEvent.click(within(await region()).getByRole("button", { name: "Change how this waits for EO-12" }));
      expect(screen.getByRole("combobox", { name: "Wait for EO-12" })).toBeInTheDocument();

      // A run starts while the editor is open, and the page reads the item again.
      current = { ...current, item: { ...current.item, contentRefusal: "EO-1 is being worked on right now, so its content cannot change under the agent holding it." } };
      await act(() => client.invalidateQueries());

      await waitFor(() => expect(screen.queryByRole("combobox", { name: "Wait for EO-12" })).not.toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
      expect(within(await region()).queryByRole("button", { name: /Change how this waits/ })).not.toBeInTheDocument();
      expect(within(await region()).getByText("Until it finishes")).toBeInTheDocument();

      // Changeable again: the row offers Change, not the editor it closed.
      current = { ...current, item: { ...current.item, contentRefusal: null } };
      await act(() => client.invalidateQueries());
      expect(await within(await region()).findByRole("button", { name: "Change how this waits for EO-12" })).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "Wait for EO-12" })).not.toBeInTheDocument();
    });

    it("offers no change where the item's content may not change", async () => {
      const data = detail({ dependsOn: [dependency()] });
      data.item.contentRefusal = "EO-1 is in review. Changing what it asks for now would invalidate the review.";
      renderItem(data);

      const blocked = await region();
      expect(within(blocked).getByText("Until it finishes")).toBeInTheDocument();
      expect(within(blocked).queryByRole("button", { name: /Change how this waits/ })).not.toBeInTheDocument();
    });
  });

  it("says when a step that keeps checking last checked and checks next (EO-456)", async () => {
    renderItem(detail({ watch: { stepId: "todo", startedAt: 1_000, lastCheckedAt: 2_000, nextCheckAt: 302_000, giveUpAt: 604_801_000, checks: 4, consecutiveFailures: 0, lastError: null } }));

    const watch = await screen.findByRole("region", { name: "Keep checking" });
    expect(within(watch).getByText(`Last checked ${new Date(2_000).toLocaleString()}`)).toBeInTheDocument();
    expect(within(watch).getByText(`Next check ${new Date(302_000).toLocaleString()}`)).toBeInTheDocument();
  });

  it("says a watch that never gives up never does, instead of a date (EO-571)", async () => {
    renderItem(detail({ watch: { stepId: "todo", startedAt: 1_000, lastCheckedAt: 2_000, nextCheckAt: 302_000, giveUpAt: null, checks: 4, consecutiveFailures: 0, lastError: null } }));

    const watch = await screen.findByRole("region", { name: "Keep checking" });
    expect(within(watch).getByText("Never gives up")).toBeInTheDocument();
    expect(within(watch).queryByText(/^Gives up/)).not.toBeInTheDocument();
  });

  it("says nothing about checking on an item that is not watching", async () => {
    renderItem(detail());
    await screen.findAllByText(detail().item.title);
    expect(screen.queryByRole("region", { name: "Keep checking" })).not.toBeInTheDocument();
  });

  it("says so plainly when the item is gone", async () => {
    window.eo.ipc.invoke = vi.fn(async (channel: string) => (channel === "items:get" ? { ok: true, data: null } : { ok: true, data: { agents: [] } })) as never;
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter>
            <ItemView itemId="gone" />
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );

    expect(await screen.findByText(/no longer exists/)).toBeInTheDocument();
  });

  it("follows an item into its own project, and stays put on the shown one", async () => {
    const elsewhere = recorder();
    const data = detail();
    data.item.projectId = "b2";
    renderItem(data, elsewhere.onCall);
    await waitFor(() => expect(payloadOf(elsewhere.calls, "projects:setActive")).toEqual({ id: "b2" }));
  });

  it("does not switch for an item already on the shown project", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail(), onCall);
    await screen.findByRole("heading", { name: "Rate limit the API" });
    expect(calls.some((call) => call.channel === "projects:setActive")).toBe(false);
  });

  it("shows a transition as a state change, by step name and actor", async () => {
    renderItem(detail({ transitions: [transition({ reason: "run succeeded", actor: "a1" })] }));

    expect(await screen.findByText(/by Implementer/)).toBeInTheDocument();
    expect(screen.getByText(/run succeeded/)).toBeInTheDocument();
  });

  it("sets the priority, names levels, and keeps a value from outside them", async () => {
    const { calls, onCall } = recorder();
    const data = detail();
    data.item.priority = 7;
    renderItem(data, onCall);

    expect(await screen.findByRole("option", { name: "Priority 7", selected: true })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "2" } });
    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", priority: 2 }));
  });
});

describe("the thread", () => {
  it("marks a comment awaiting the human, distinctly from an answered one", async () => {
    renderItem(detail({ comments: [comment({ id: "c1", body: "Which limit?", awaitingHuman: true, kind: "escalation" }), comment({ id: "c2", body: "Answered one" })] }));

    await screen.findByText("Which limit?");
    expect(screen.getAllByText("awaiting your reply")).toHaveLength(1);
  });

  it("posts an offered option as a reply to its question, and closes the box", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail({ comments: [comment({ body: "Which database?", kind: "question", options: ["Postgres", "SQLite"], awaitingHuman: true })] }), onCall);

    fireEvent.click(await screen.findByRole("button", { name: "Postgres" }));

    await waitFor(() => expect(payloadOf(calls, "comments:post")).toMatchObject({ itemId: "t1", body: "Postgres", parentId: "c1" }));
    await waitFor(() => expect(screen.queryByPlaceholderText(/in your own words/)).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "SQLite" })).not.toBeInTheDocument();
  });

  it("lets a question with options be answered in your own words", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail({ comments: [comment({ body: "Which database?", kind: "question", options: ["Postgres"], awaitingHuman: true })] }), onCall);

    fireEvent.change(await screen.findByPlaceholderText(/in your own words/), { target: { value: "neither — use DuckDB" } });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));

    await waitFor(() => expect(payloadOf(calls, "comments:post")).toMatchObject({ body: "neither — use DuckDB", parentId: "c1" }));
  });

  it("draws a conflict notice's Fix with assistant on the comment, as an action that opens the chat rather than a reply", async () => {
    const { calls, onCall } = recorder();
    renderItem(
      detail({
        comments: [
          comment({
            id: "notice-1",
            authorType: "engine",
            authorName: "EO",
            body: "**Delivery** could not take the *Software feature to merge* template's update from 1.0 to 1.1.",
            options: [{ kind: "open", label: "Fix with assistant", opens: { type: "updateConflictChat", conflictId: "conflict-1" } }],
            awaitingHuman: true,
          }),
        ],
      }),
      onCall,
      { "assist:openUpdateConflict": { conversation: { id: "chat-1", messages: [] }, problem: null, projectId: null } },
    );

    const button = await screen.findByRole("button", { name: "Fix with assistant" });
    // Not among the offered answers: the reply box offers none.
    expect(screen.queryByRole("group", { name: "Offered answers" })).toBeNull();
    expect(screen.queryByLabelText("Offered answers")).toBeNull();

    fireEvent.click(button);

    await waitFor(() => expect(payloadOf(calls, "assist:openUpdateConflict")).toEqual({ conflictId: "conflict-1", commentId: "notice-1" }));
    await waitFor(() => expect(screen.getByTestId("current-route")).toHaveTextContent("/chat"));
    expect(calls.some((call) => call.channel === "comments:post")).toBe(false);
  });

  it("navigates from a key inside an option without posting it", async () => {
    const { calls, onCall } = recorder();
    renderItem(
      detail({
        comments: [comment({ body: "Which dependency?", kind: "question", options: ["Wait for EO-2"], awaitingHuman: true })],
        dependsOn: [{ id: "t2", key: "EO-2", title: "Dependency", stepId: "todo", stepName: "Implementer", wait: "finished", waitStepId: null, waitStepName: null }],
      }),
      onCall,
    );

    const choice = await screen.findByRole("button", { name: "Wait for EO-2" });
    const link = await within(choice.parentElement!).findByRole("link", { name: "EO-2" });
    fireEvent.pointerDown(link);
    fireEvent.click(link);

    expect(calls.some((call) => call.channel === "comments:post")).toBe(false);
    expect(screen.getByTestId("current-route")).toHaveTextContent("/items/t2");
  });

  it("sizes a long option's chip by its words, under a press target that fills the chip (EO-722)", async () => {
    // jsdom lays nothing out, so this holds the structure that makes the
    // target cover the words; offeredAnswers.spec.ts measures the window.
    const long = [
      "(A) Keep the current behaviour and document it, since changing it would break every caller that relies on the old order.",
      "(B) Change it now and migrate the callers in the same change, accepting the larger diff.",
    ];
    const { calls, onCall } = recorder();
    renderItem(detail({ comments: [comment({ body: "Which way?", kind: "question", options: long, awaitingHuman: true })] }), onCall);

    for (const option of long) {
      const target = await screen.findByRole("button", { name: option });
      const chip = target.parentElement!;
      const words = within(chip).getByText(option);
      // The words are inside the chip the target fills, and give it its height.
      expect(target.className).toMatch(/\babsolute\b/);
      expect(target.className).toMatch(/\binset-0\b/);
      expect(chip.className).toMatch(/\brelative\b/);
      expect(words.closest(".min-h-\\[26px\\]")).not.toBeNull();
      expect(chip.innerHTML).not.toMatch(/[\s"]h-\[/);
    }

    fireEvent.click(screen.getByRole("button", { name: long[0]! }));
    await waitFor(() => expect(payloadOf(calls, "comments:post")).toMatchObject({ body: long[0]!, parentId: "c1" }));
  });

  it("files an answer under its question", async () => {
    renderItem(
      detail({
        comments: [
          comment({ id: "c1", body: "Which rate limit?", kind: "question" }),
          comment({ id: "c2", body: "Which database?", kind: "question" }),
          comment({ id: "c3", body: "100 a minute", authorType: "human", parentId: "c1", createdAt: 3 }),
        ],
      }),
    );

    await screen.findByText("Which rate limit?");
    expect(screen.getByText("100 a minute").closest("div.border-l")).not.toBeNull();
    expect(screen.getByText("Which database?").closest("div.border-l")).toBeNull();
  });

  it("pins a comment", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail({ comments: [comment()] }), onCall);

    fireEvent.click(await screen.findByRole("button", { name: "Pin comment" }));
    await waitFor(() => expect(payloadOf(calls, "comments:setPinned")).toMatchObject({ commentId: "c1", pinned: true }));
  });

  it("draws a pin as pending the moment it is pressed, until the thread is read again (EO-562)", async () => {
    let land: (value: unknown) => void = () => {};
    let pinnedNow = false;
    const invoke = renderItem(detail({ comments: [comment()] }));
    const answered = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel: string, payload: unknown) => {
      if (channel === "comments:setPinned") return new Promise<never>((resolve) => (land = resolve as (value: unknown) => void));
      if (channel === "items:get") return { ok: true, data: detail({ comments: [comment({ pinned: pinnedNow })] }) };
      return answered(channel, payload);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Pin comment" }));
    const pending = await screen.findByRole("button", { name: "Pinning comment…" });
    expect(pending).toBeDisabled();
    expect(screen.getByText("pinning…")).toBeInTheDocument();
    fireEvent.click(pending);
    expect(invoke.mock.calls.filter(([channel]) => channel === "comments:setPinned")).toHaveLength(1);

    pinnedNow = true;
    await act(async () => land({ ok: true, data: { pinned: true, found: true } }));
    expect(await screen.findByRole("button", { name: "Unpin comment" })).toBeEnabled();
    expect(screen.getByText("pinned")).toBeInTheDocument();
    // A tag, not something to press: neutral rather than the accent (EO-689).
    expect(screen.getByText("pinned").className).not.toMatch(/accent/);
    expect(screen.queryByText("pinning…")).not.toBeInTheDocument();
  });

  it("takes a refused pin back and says why (EO-562)", async () => {
    let refuse: (value: unknown) => void = () => {};
    const invoke = renderItem(detail({ comments: [comment()] }));
    const answered = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel: string, payload: unknown) =>
      channel === "comments:setPinned" ? new Promise<never>((resolve) => (refuse = resolve as (value: unknown) => void)) : answered(channel, payload),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pin comment" }));
    expect(await screen.findByText("pinning…")).toBeInTheDocument();
    await act(async () => refuse({ ok: false, error: { message: "The comment is gone." } }));

    expect(await screen.findByText(/Could not pin the comment: The comment is gone\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin comment" })).toBeEnabled();
    expect(screen.queryByText("pinning…")).not.toBeInTheDocument();
    expect(screen.queryByText("pinned")).not.toBeInTheDocument();
  });

  it("posts a comment with the mentions it names, and no delivery when nothing runs", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail(), onCall);

    const box = await screen.findByLabelText("Write a comment");
    expect(screen.queryByLabelText("Send behavior")).not.toBeInTheDocument();
    fireEvent.change(box, { target: { value: "@implementer please retry" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => expect(payloadOf(calls, "comments:post")).toMatchObject({ body: "@implementer please retry", mentions: ["implementer"], parentId: null }));
    expect(payloadOf(calls, "comments:post")).not.toHaveProperty("delivery");
  });

  it("tells the composer an agent is working, and sends the message into that turn (EO-176)", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail({ runs: [liveRun()] }), onCall, {
      "comments:post": { commentId: "c9", resumedRun: false, delivery: { requested: "now", outcome: "now", note: null } },
    });

    await screen.findByLabelText("Send behavior");
    expect(screen.getByText(/Implementer is working — this will be said to it now/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Write a comment"), { target: { value: "Use the middleware." } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => expect(payloadOf(calls, "comments:post")).toMatchObject({ itemId: "t1", body: "Use the middleware.", delivery: "now" }));
  });
});

describe("attachments", () => {
  it("previews images, sizes files, and opens, saves and deletes each", async () => {
    const { calls, onCall } = recorder();
    renderItem(
      detail({
        comments: [
          comment({
            body: "Files from the run.",
            attachments: [
              { id: "a-image", itemId: "t1", commentId: "c1", kind: "image", name: "screen.png", mimeType: "image/png", size: 8 },
              { id: "a-file", itemId: "t1", commentId: "c1", kind: "file", name: "report.pdf", mimeType: "application/pdf", size: 2048 },
            ],
          }),
        ],
      }),
      onCall,
      {
        "attachments:preview": { dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
        "attachments:open": { opened: true, problem: null },
        "attachments:save": { saved: true, problem: null },
        "attachments:delete": { deleted: true },
      },
    );

    expect(await screen.findByRole("img", { name: "screen.png" })).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open report.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Save report.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete report.pdf" }));

    await waitFor(() => {
      expect(calls).toContainEqual({ channel: "attachments:open", payload: { attachmentId: "a-file" } });
      expect(calls).toContainEqual({ channel: "attachments:save", payload: { attachmentId: "a-file" } });
      expect(calls).toContainEqual({ channel: "attachments:delete", payload: { attachmentId: "a-file" } });
    });
  });

  it("shows where each stands with Jira, and the retrying operations", async () => {
    renderItem(
      detail({
        attachmentSync: { pending: 1, error: "Jira returned 503" },
        comments: [
          comment({
            attachments: [
              { id: "s", itemId: "t1", commentId: "c1", kind: "file", name: "done.txt", mimeType: "text/plain", size: 1, syncStatus: "synchronized", syncError: null },
              { id: "p", itemId: "t1", commentId: "c1", kind: "file", name: "wait.txt", mimeType: "text/plain", size: 1, syncStatus: "pending", syncError: null },
              { id: "f", itemId: "t1", commentId: "c1", kind: "file", name: "retry.txt", mimeType: "text/plain", size: 1, syncStatus: "error", syncError: "Jira returned 503" },
            ],
          }),
        ],
      }),
    );

    expect(await screen.findByLabelText("done.txt synchronized with Jira")).toBeInTheDocument();
    expect(screen.getByLabelText("wait.txt pending Jira synchronization")).toBeInTheDocument();
    expect(screen.getByLabelText("Jira synchronization failed for retry.txt")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Jira attachment synchronization is retrying");
  });
});

describe("deleting the item", () => {
  const DELETED = { deleted: true, deletedCount: 1, blockedByActiveRun: false, blockedByUncommittedWork: false, problem: null, jira: null, leftoverWorktrees: [] };

  async function openDialog(data: ItemDetailData, onCall?: (channel: string, payload: unknown) => void, replies: Record<string, unknown> = {}) {
    renderItem(data, onCall, { "items:delete": DELETED, ...replies });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  }

  it("asks first, and deletes nothing when the answer is no", async () => {
    const { calls, onCall } = recorder();
    await openDialog(detail(), onCall);

    const dialog = await screen.findByRole("dialog", { name: "Delete EO-1?" });
    expect(within(dialog).getByRole("link", { name: "EO-1" })).toHaveAttribute("href", "/items/t1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.some((call) => call.channel === "items:delete")).toBe(false);
  });

  it("says what goes with a container, and what it cost, whatever the container is called", async () => {
    const data = detail();
    data.item.type = "epic";
    data.item.container = true;
    data.runs = [liveRun({ status: "succeeded", endedAt: 2 })];
    await openDialog(data, undefined, {
      "items:list": { items: [data.item, { ...data.item, id: "s1", key: "S1", parentId: "t1" }, { ...data.item, id: "s2", key: "S2", parentId: "t1" }] },
      "costs:getForItem": { itemId: "t1", costCents: 981 },
    });

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/2 tickets under it/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 run/)).toBeInTheDocument();
    expect(within(dialog).getByText(/9\.81 USD/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete this and everything under it" })).toBeInTheDocument();
  });

  it("shows a container's Memory section, whatever the container is called, and reads its container scope (EO-596)", async () => {
    const { calls, onCall } = recorder();
    const data = detail();
    data.item.type = "epic";
    data.item.container = true;
    data.item.stepId = null;
    data.item.pipelineId = null;
    renderItem(data, onCall, {
      "memory:list": { entries: [] },
      "memory:consolidations": { consolidations: [], pending: null },
    });

    const section = await screen.findByRole("region", { name: "Memory of Rate limit the API" });
    expect(within(section).getByText("Memory")).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "Show the memory of Rate limit the API" }));
    expect(await within(section).findByText(/only while the work filed here is in progress/)).toBeInTheDocument();
    await waitFor(() => expect(payloadOf(calls, "memory:list")).toEqual(expect.objectContaining({ scope: { kind: "container", id: "t1" } })));
  });

  it("shows no Memory section on an item that is not a container (EO-596)", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail(), onCall);

    expect(await screen.findByRole("heading", { name: "Rate limit the API" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Memory of/ })).not.toBeInTheDocument();
    expect(calls.some((call) => call.channel === "memory:list")).toBe(false);
  });

  it("offers Jira only with a live link, unticked, and passes the choice through", async () => {
    const { calls, onCall } = recorder();
    const data = detail();
    data.item.jiraKey = "ACME-7";
    data.item.jiraUrl = "https://acme.atlassian.net/browse/ACME-7";
    await openDialog(data, onCall);

    const box = await screen.findByRole("checkbox");
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Delete this ticket" }));

    await waitFor(() => expect(payloadOf(calls, "items:delete")).toMatchObject({ deleteInJira: true }));
  });

  it("stays open on Escape while the delete is in flight, so what comes back is read", async () => {
    await openDialog(detail());
    const dialog = await screen.findByRole("dialog", { name: "Delete EO-1?" });
    // Hold the delete until the test lets it go.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const invoke = window.eo.ipc.invoke;
    window.eo.ipc.invoke = (async (channel: string, payload: unknown) => {
      if (channel === "items:delete") await held;
      return invoke(channel as never, payload as never);
    }) as never;

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete this ticket" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Keep it" })).toBeDisabled());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Delete EO-1?" })).toBeInTheDocument();

    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("turns a refusal into the sharper question", async () => {
    const { calls, onCall } = recorder();
    await openDialog(detail(), onCall, {
      "items:delete": { deleted: false, deletedCount: 0, blockedByActiveRun: true, blockedByUncommittedWork: false, problem: "An agent is working on EO-1 right now.", jira: null },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Delete this ticket" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("An agent is working on EO-1 right now.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel the run and delete" }));

    await waitFor(() => expect(calls.filter((call) => call.channel === "items:delete")).toHaveLength(2));
    expect(calls.filter((call) => call.channel === "items:delete")[1]?.payload).toMatchObject({ cancelActiveRun: true });
  });

  it("names a checkout the delete could not remove, and leaves only once that is dismissed", async () => {
    await openDialog(detail(), undefined, {
      "items:delete": { ...DELETED, leftoverWorktrees: [{ itemKey: "EO-1", path: "/home/dev/.eo/worktrees/EO-1", problem: "git worktree remove failed" }] },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Delete this ticket" }));
    const report = await screen.findByRole("dialog", { name: "EO-1 was deleted" });
    expect(within(report).getByText("/home/dev/.eo/worktrees/EO-1")).toBeInTheDocument();
    expect(screen.getByTestId("current-route")).toHaveTextContent("/items/t1");
    fireEvent.click(within(report).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(screen.getByTestId("current-route")).toHaveTextContent(/^\/$/));
  });

  it("archives without asking, and leaves for the board", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail(), onCall, { "items:setArchived": { archived: true } });

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    await waitFor(() => expect(payloadOf(calls, "items:setArchived")).toEqual({ itemId: "t1", archived: true }));
    await waitFor(() => expect(screen.getByTestId("current-route")).toHaveTextContent("/project"));
  });
});

describe("deleting a comment", () => {
  const DELETED = { deleted: true, deletedCount: 1, problem: null, jira: null };

  it("asks first, says how many replies go, and deletes in Jira by default", async () => {
    const { calls, onCall } = recorder();
    const data = detail();
    data.item.jiraKey = "ACME-7";
    data.comments = [comment({ id: "c1", body: "Which database?", kind: "question", mirroredInJira: true }), comment({ id: "c2", body: "Postgres", parentId: "c1", createdAt: 200 })];
    renderItem(data, onCall, { "comments:delete": DELETED });

    fireEvent.click((await screen.findAllByRole("button", { name: "Delete comment" }))[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Delete this comment?" });
    expect(within(dialog).getByText(/1 reply filed under it/)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox")).toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(payloadOf(calls, "comments:delete")).toMatchObject({ commentId: "c1", deleteInJira: true }));
  });

  it("offers nothing about Jira for a comment that was never mirrored", async () => {
    renderItem(detail({ comments: [comment()] }), undefined, { "comments:delete": DELETED });
    fireEvent.click(await screen.findByRole("button", { name: "Delete comment" }));
    await screen.findByRole("dialog", { name: "Delete this comment?" });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("reports what Jira would not remove, once the local half is done", async () => {
    const data = detail();
    data.item.jiraKey = "ACME-7";
    data.comments = [comment({ mirroredInJira: true })];
    renderItem(data, undefined, { "comments:delete": { deleted: true, deletedCount: 1, problem: null, jira: { attempted: 1, deleted: 0, problem: "ACME-7 comment 10101: 403" } } });

    fireEvent.click(await screen.findByRole("button", { name: "Delete comment" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Delete this comment?" })).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("403");
  });
});

describe("Jira", () => {
  const UPDATED = { updated: true, problem: null };
  function mirrored(): ItemDetailData {
    const data = detail();
    data.item.jiraKey = "ACME-8";
    data.item.jiraUrl = "https://acme.atlassian.net/browse/ACME-8";
    return data;
  }

  it("offers Sync now only on a mirrored item, and says what it brought back", async () => {
    renderItem(mirrored(), undefined, { "jira:pull": { comments: 2, edits: 1, attachments: 0, skippedAttachments: 0, problem: null } });

    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(await screen.findByRole("status")).toHaveTextContent("2 comments and 1 edit");
  });

  it("has no Sync now for an item with no issue", async () => {
    renderItem(detail());
    await screen.findByRole("heading", { name: "Rate limit the API" });
    expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
  });

  it("attaches an issue, trimmed, and on return too", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail(), onCall, { "items:update": UPDATED });

    const box = await screen.findByLabelText("Jira issue key");
    expect(screen.getByRole("button", { name: "Attach issue" })).toBeDisabled();
    fireEvent.change(box, { target: { value: "  kan-123  " } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", jiraKey: "kan-123" }));
  });

  it("reads as a fact until somebody changes it, moves, and detaches", async () => {
    const { calls, onCall } = recorder();
    renderItem(mirrored(), onCall, { "items:update": UPDATED });

    const jira = await screen.findByRole("region", { name: "Jira" });
    expect(within(jira).queryByLabelText("Jira issue key")).not.toBeInTheDocument();
    fireEvent.click(within(jira).getByRole("button", { name: "Change" }));
    expect(within(jira).getByLabelText("Jira issue key")).toHaveValue("ACME-8");
    expect(within(jira).getByRole("button", { name: "Move issue" })).toBeDisabled();
    fireEvent.click(within(jira).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(jira).getByRole("button", { name: "Detach" }));

    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", jiraKey: null }));
  });

  it("shows a refusal beside the box and keeps what was typed", async () => {
    renderItem(detail(), undefined, { "items:update": { updated: false, problem: "EO-9 is already linked to KAN-1." } });

    fireEvent.change(await screen.findByLabelText("Jira issue key"), { target: { value: "KAN-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach issue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("EO-9 is already linked to KAN-1.");
    expect(screen.getByLabelText("Jira issue key")).toHaveValue("KAN-1");
  });

  it("refuses the switch with no key, and throws it once there is one", async () => {
    const { calls, onCall } = recorder();
    const data = mirrored();
    data.item.jiraSync = false;
    renderItem(data, onCall, { "items:update": UPDATED });

    const jira = await screen.findByRole("region", { name: "Jira" });
    expect(within(jira).getByText("Not syncing")).toBeInTheDocument();
    expect(jira).toHaveTextContent("nothing reaches ACME-8");
    fireEvent.click(within(jira).getByRole("switch", { name: "Sync with Jira" }));
    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", jiraSync: true }));
  });

  it("disables the switch while nothing is attached", async () => {
    renderItem(detail());
    expect(await screen.findByRole("switch", { name: "Sync with Jira" })).toBeDisabled();
  });

  it("is absent when the repository names no Jira site", async () => {
    const data = detail();
    data.item.jiraConnected = false;
    renderItem(data);
    await screen.findByRole("heading", { name: "Rate limit the API" });
    expect(screen.queryByRole("region", { name: "Jira" })).not.toBeInTheDocument();
  });

  it("says on a container that the switch reaches everything under it, in the project's word", async () => {
    const data = mirrored();
    data.item.container = true;
    renderItem(data);
    expect(await screen.findByRole("region", { name: "Jira" })).toHaveTextContent("changes everything under this ticket");
  });
});

describe("the Reference (EO-637)", () => {
  const UPDATED = { updated: true, problem: null };
  function withReference(own: string | null, reference: { value: string; inheritedFrom: string | null } | null): ItemDetailData {
    const data = detail();
    data.item.git = { ...NO_GIT_STATE, reference: own };
    data.item.reference = reference;
    return data;
  }

  it.each([
    ["a story", "developer:story", false],
    ["a bug", "developer:bug", false],
    ["a feature", "developer:feature", true],
  ])("is offered on %s, and sets one, trimmed, on return", async (_label, typeKey, container) => {
    const { calls, onCall } = recorder();
    const data = detail();
    data.item.typeKey = typeKey;
    data.item.container = container;
    renderItem(data, onCall, { "items:update": UPDATED });

    const field = await screen.findByRole("region", { name: "Reference" });
    expect(field).toHaveTextContent("None");
    fireEvent.click(within(field).getByRole("button", { name: "Set" }));
    const box = within(field).getByLabelText("Reference value");
    fireEvent.change(box, { target: { value: "  PROJ-123  " } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", reference: "PROJ-123" }));
  });

  it("changes and clears the item's own", async () => {
    const { calls, onCall } = recorder();
    renderItem(withReference("PROJ-123", { value: "PROJ-123", inheritedFrom: null }), onCall, { "items:update": UPDATED });

    const field = await screen.findByRole("region", { name: "Reference" });
    expect(field).toHaveTextContent("PROJ-123");
    expect(field).not.toHaveTextContent("Inherited");
    fireEvent.click(within(field).getByRole("button", { name: "Change" }));
    expect(within(field).getByLabelText("Reference value")).toHaveValue("PROJ-123");
    fireEvent.click(within(field).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(field).getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", reference: null }));
  });

  it("clears with an emptied box", async () => {
    const { calls, onCall } = recorder();
    renderItem(withReference("PROJ-123", { value: "PROJ-123", inheritedFrom: null }), onCall, { "items:update": UPDATED });

    const field = await screen.findByRole("region", { name: "Reference" });
    fireEvent.click(within(field).getByRole("button", { name: "Change" }));
    fireEvent.change(within(field).getByLabelText("Reference value"), { target: { value: "   " } });
    fireEvent.click(within(field).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", reference: null }));
  });

  it("shows a refusal beside the box and keeps what was typed", async () => {
    renderItem(detail(), undefined, { "items:update": { updated: false, problem: '"PROJ 123" cannot be a Reference, because a Reference has to fit in a git branch name and it contains a space.' } });

    const field = await screen.findByRole("region", { name: "Reference" });
    fireEvent.click(within(field).getByRole("button", { name: "Set" }));
    fireEvent.change(within(field).getByLabelText("Reference value"), { target: { value: "PROJ 123" } });
    fireEvent.click(within(field).getByRole("button", { name: "Save" }));

    expect(await within(field).findByRole("alert")).toHaveTextContent("it contains a space");
    expect(within(field).getByLabelText("Reference value")).toHaveValue("PROJ 123");
  });

  it("shows its feature's as inherited, naming the feature, with nothing of its own to clear", async () => {
    renderItem(withReference(null, { value: "PROJ-123", inheritedFrom: "EO-1" }));

    const field = await screen.findByRole("region", { name: "Reference" });
    expect(field).toHaveTextContent("PROJ-123");
    expect(within(field).getByText("Inherited from EO-1")).toBeInTheDocument();
    expect(within(field).getByRole("button", { name: "Set" })).toBeInTheDocument();
    expect(within(field).queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
  });
});

describe("the pull request reviewers (EO-742)", () => {
  const UPDATED = { updated: true, problem: null };
  function withReviewers(own: string[] | null, reviewers: { value: string[]; inheritedFrom: string | null }): ItemDetailData {
    const data = detail();
    data.item.git = { ...NO_GIT_STATE, reviewers: own };
    data.item.reviewers = reviewers;
    return data;
  }

  it("shows its feature's as inherited, naming the feature", async () => {
    renderItem(withReviewers(null, { value: ["dave"], inheritedFrom: "EO-1" }));

    const field = await screen.findByRole("region", { name: "Pull request reviewers" });
    expect(field).toHaveTextContent("dave");
    expect(within(field).getByText("Inherited from EO-1")).toBeInTheDocument();
    expect(within(field).queryByRole("button", { name: "Inherit" })).not.toBeInTheDocument();
  });

  it("says when they are the repository's default", async () => {
    renderItem(withReviewers(null, { value: ["alice", "bob"], inheritedFrom: "repository" }));

    const field = await screen.findByRole("region", { name: "Pull request reviewers" });
    expect(field).toHaveTextContent("alice, bob");
    expect(within(field).getByText("From the repository")).toBeInTheDocument();
  });

  it("sets the item's own from handles separated by commas or spaces", async () => {
    const { calls, onCall } = recorder();
    renderItem(withReviewers(null, { value: ["alice"], inheritedFrom: "repository" }), onCall, { "items:update": UPDATED });

    const field = await screen.findByRole("region", { name: "Pull request reviewers" });
    fireEvent.click(within(field).getByRole("button", { name: "Set" }));
    const box = within(field).getByLabelText("Reviewers");
    fireEvent.change(box, { target: { value: " carol,  acme/backend " } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", reviewers: ["carol", "acme/backend"] }));
  });

  it("sets it to nobody", async () => {
    const { calls, onCall } = recorder();
    renderItem(withReviewers(null, { value: ["alice"], inheritedFrom: "repository" }), onCall, { "items:update": UPDATED });

    const field = await screen.findByRole("region", { name: "Pull request reviewers" });
    fireEvent.click(within(field).getByRole("button", { name: "Ask nobody" }));

    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", reviewers: [] }));
  });

  it("shows its own empty list as nobody, and clears it back to inheriting", async () => {
    const { calls, onCall } = recorder();
    renderItem(withReviewers([], { value: [], inheritedFrom: null }), onCall, { "items:update": UPDATED });

    const field = await screen.findByRole("region", { name: "Pull request reviewers" });
    expect(field).toHaveTextContent("Nobody");
    expect(within(field).queryByText(/Inherited|From the repository/)).not.toBeInTheDocument();
    expect(within(field).queryByRole("button", { name: "Ask nobody" })).not.toBeInTheDocument();
    fireEvent.click(within(field).getByRole("button", { name: "Inherit" }));

    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", reviewers: null }));
  });

  it("shows a refusal beside the box", async () => {
    renderItem(withReviewers(null, { value: [], inheritedFrom: "repository" }), undefined, {
      "items:update": { updated: false, problem: '"a b" is not a reviewer EO can ask for.' },
    });

    const field = await screen.findByRole("region", { name: "Pull request reviewers" });
    fireEvent.click(within(field).getByRole("button", { name: "Set" }));
    fireEvent.change(within(field).getByLabelText("Reviewers"), { target: { value: "carol" } });
    fireEvent.click(within(field).getByRole("button", { name: "Save" }));

    expect(await within(field).findByRole("alert")).toHaveTextContent("is not a reviewer EO can ask for");
  });
});

describe("the About card", () => {
  it("states where the item stands, and names the job that made it", async () => {
    const data = detail({ item: { ...detail().item, stepId: "review", git: { ...NO_GIT_STATE, branch: "feat/limits" } } });
    data.item.origin = { jobId: "j1", jobName: "Monday report", trigger: "manual", costCents: 0, occurrenceId: "o1", firedAt: 5, findingKey: null };
    renderItem(data);

    const about = await screen.findByRole("complementary", { name: "About" });
    await waitFor(() => expect(within(about).getByText("Review")).toBeInTheDocument());
    expect(within(about).getByText("feat/limits")).toBeInTheDocument();
    expect(within(about).getByText(/job “Monday report”/)).toBeInTheDocument();
    expect(within(about).getByText("Delivery")).toBeInTheDocument();
  });

  it("names the watch job that filed it and the finding's key (EO-754)", async () => {
    const data = detail();
    data.item.origin = { jobId: "j1", jobName: "Dependabot", trigger: "watch", costCents: 0, occurrenceId: "o1", firedAt: 5, findingKey: "pr-412" };
    renderItem(data);

    const about = await screen.findByRole("complementary", { name: "About" });
    expect(await within(about).findByText("watch “Dependabot”, finding pr-412")).toBeInTheDocument();
  });

  it("has no From for an item a person filed", async () => {
    renderItem(detail());
    const about = await screen.findByRole("complementary", { name: "About" });
    expect(within(about).queryByText("From")).not.toBeInTheDocument();
  });

  it("shows the item's pipeline with the step it is on", async () => {
    renderItem(detail({ item: { ...detail().item, stepId: "review" } }));
    const stepper = await screen.findByRole("list", { name: "Pipeline steps" });
    await waitFor(() => expect(within(stepper).getByText("Review").closest("li")).toHaveAttribute("aria-current", "step"));
  });

  it("links the latest run to its transcript, with what its workspace checked", async () => {
    renderItem(
      detail({
        runs: [
          liveRun({
            status: "failed",
            checks: [
              { key: "implementation", passed: true, describes: "Every step passed." },
              { key: "borrowed-files", passed: false, describes: "2 files are byte-identical to unapproved work." },
            ],
          }),
        ],
      }),
    );

    const about = await screen.findByRole("complementary", { name: "About" });
    expect(within(about).getByRole("link", { name: "View run details" })).toHaveAttribute("href", "/items/t1/runs");
    expect(within(about).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["Passed:Every step passed.", "Failed:2 files are byte-identical to unapproved work."]);
  });

  it("omits the run before anything has run", async () => {
    renderItem(detail());
    await screen.findByRole("complementary", { name: "About" });
    expect(screen.queryByRole("link", { name: "View run details" })).not.toBeInTheDocument();
  });
});

describe("editing criteria (EO-166)", () => {
  it("corrects them in place, one per line", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail({ item: { ...detail().item, acceptanceCriteria: ["429 after 100 req/min", "Retry-After is set"] } }), onCall, { "items:update": { updated: true, problem: null } });

    fireEvent.click(await screen.findByRole("button", { name: "Edit criteria" }));
    const box = screen.getByLabelText("Acceptance criteria, one per line");
    expect(box).toHaveValue("429 after 100 req/min\nRetry-After is set");
    fireEvent.change(box, { target: { value: "429 after 60 req/min\nRetry-After is set\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save criteria" }));

    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", acceptanceCriteria: ["429 after 60 req/min", "Retry-After is set"] }));
  });

  it("offers to write the first, says nothing on a container with none, and gives nobody a box to tick", async () => {
    renderItem(detail({ item: { ...detail().item, acceptanceCriteria: [] } }));
    const region = await screen.findByRole("region", { name: "Acceptance criteria" });
    expect(within(region).getByText("None recorded.")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Add criteria" })).toBeInTheDocument();
    expect(within(region).queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("says nothing about criteria on a container that has none", async () => {
    renderItem(detail({ item: { ...detail().item, container: true, acceptanceCriteria: [] } }));
    await screen.findByRole("heading", { name: "Rate limit the API" });
    expect(screen.queryByRole("region", { name: "Acceptance criteria" })).not.toBeInTheDocument();
  });

  it("shows a refusal beside the box and keeps what was typed", async () => {
    renderItem(detail(), undefined, { "items:update": { updated: false, problem: "EO-1 is being worked on right now." } });

    fireEvent.click(await screen.findByRole("button", { name: "Edit criteria" }));
    fireEvent.change(screen.getByLabelText("Acceptance criteria, one per line"), { target: { value: "429 after 60 req/min" } });
    fireEvent.click(screen.getByRole("button", { name: "Save criteria" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("being worked on right now");
    expect(screen.getByLabelText("Acceptance criteria, one per line")).toHaveValue("429 after 60 req/min");
  });
});

describe("the spec editor, drawn from the type's shape (KAN-147)", () => {
  const SHAPE = {
    type: "object" as const,
    properties: { customer: { type: "string", minLength: 1 }, channel: { type: "string", enum: ["email", "phone"] }, breached: { type: "boolean" } },
    required: ["customer"],
  };
  const REGISTRY = { roles: [], builtins: [], itemTypes: [{ packSlug: "support", slug: "case", label: "Case", plural: "Cases", container: false, specShape: SHAPE, actionOverrides: {} }] };
  const caseItem = (spec: Record<string, unknown> | null, typeKey = "support:case") => detail({ item: { ...detail().item, type: "case", typeKey, acceptanceCriteria: [], spec } });

  it("draws a field per property and edits only what was touched", async () => {
    const { calls, onCall } = recorder();
    renderItem(caseItem({ customer: "ACME", channel: "email" }), onCall, { "registry:get": REGISTRY, "items:update": { updated: true, problem: null } });

    const edit = await screen.findByRole("button", { name: "Edit details" });
    expect(within(screen.getByRole("region", { name: "Details" })).getByText("ACME")).toBeInTheDocument();
    fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "Globex" } });
    fireEvent.change(screen.getByLabelText("Channel"), { target: { value: "phone" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    // `breached` was never touched, so it is not decided as false.
    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", spec: { customer: "Globex", channel: "phone" } }));
  });

  it("sends a boolean the person did move", async () => {
    const { calls, onCall } = recorder();
    renderItem(caseItem({ customer: "ACME" }), onCall, { "registry:get": REGISTRY, "items:update": { updated: true, problem: null } });

    fireEvent.click(await screen.findByRole("button", { name: "Edit details" }));
    fireEvent.click(screen.getByRole("switch", { name: "Breached" }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", spec: { breached: true } }));
  });

  it("asks for nothing when opened and saved unchanged", async () => {
    const { calls, onCall } = recorder();
    renderItem(caseItem({ customer: "ACME" }), onCall, { "registry:get": REGISTRY });

    fireEvent.click(await screen.findByRole("button", { name: "Edit details" }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save details" })).not.toBeInTheDocument());
    expect(payloadOf(calls, "items:update")).toBeUndefined();
  });

  it("shows the type's own refusal beside the boxes, keeping what was typed", async () => {
    renderItem(caseItem(null), undefined, { "registry:get": REGISTRY, "items:update": { updated: false, problem: "A case needs customer." } });

    fireEvent.click(await screen.findByRole("button", { name: "Add details" }));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("case needs customer");
    expect(screen.getByLabelText("Customer")).toHaveValue("  ");
  });

  it("reads, and never offers to edit, the values of a type this registry has no shape for", async () => {
    renderItem(caseItem({ customer: "ACME" }, "support:incident"), undefined, { "registry:get": REGISTRY });

    const details = await screen.findByRole("region", { name: "Details" });
    expect(within(details).getByText("Customer")).toBeInTheDocument();
    expect(within(details).getByText("ACME")).toBeInTheDocument();
    expect(within(details).queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers a field a project added to a pack's type, empty until somebody sets it (EO-735)", async () => {
    const { calls, onCall } = recorder();
    const added = {
      roles: [],
      builtins: [],
      itemTypes: [
        {
          packSlug: "support",
          slug: "case",
          label: "Case",
          plural: "Cases",
          container: false,
          specShape: { ...SHAPE, properties: { ...SHAPE.properties, automerge: { type: "boolean", "x-eo-added": true }, note: { type: "string", "x-eo-added": true } } },
          actionOverrides: {},
        },
      ],
    };
    renderItem(caseItem({ customer: "ACME" }), onCall, { "registry:get": added, "items:update": { updated: true, problem: null } });

    fireEvent.click(await screen.findByRole("button", { name: "Edit details" }));
    expect(screen.getByRole("switch", { name: "Automerge" })).not.toBeChecked();
    expect(screen.getByLabelText("Note")).toHaveValue("");
    fireEvent.click(screen.getByRole("switch", { name: "Automerge" }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    // Only the field moved; `note`, never touched, is not decided as "".
    await waitFor(() => expect(payloadOf(calls, "items:update")).toEqual({ itemId: "t1", spec: { automerge: true } }));
  });

  it("says nothing at all for a type whose only field is its criteria", async () => {
    renderItem(detail(), undefined, {
      "registry:get": {
        roles: [],
        builtins: [],
        itemTypes: [
          {
            packSlug: "developer",
            slug: "story",
            label: "Story",
            plural: "Stories",
            container: false,
            specShape: { type: "object", properties: { acceptance_criteria: { type: "array", items: { type: "string" }, "x-eo-criteria": true } }, required: [] },
            actionOverrides: {},
          },
        ],
      },
    });
    await screen.findByRole("heading", { name: "Rate limit the API" });
    expect(screen.queryByRole("region", { name: "Details" })).not.toBeInTheDocument();
  });
});

describe("deciding on a human step", () => {
  const DECISION = [
    { key: "approved", label: "Approve", tone: "success" as const, requiresComment: false, targetName: "Send" },
    { key: "send_back", label: "Send back", tone: "warning" as const, requiresComment: true, targetName: "Draft" },
  ];

  it("shows nothing where there is nothing to decide", async () => {
    renderItem(detail());
    await screen.findByRole("heading", { name: "Rate limit the API" });
    expect(screen.queryByRole("region", { name: "Decide" })).toBeNull();
  });

  it("decides on the click, and asks why before sending anything back", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail({ decision: DECISION }), onCall, { "items:decide": { decided: true, toStepId: "draft", toStepName: "Draft", toPipelineId: null, commentId: null, problem: null } });

    const decide = await screen.findByRole("region", { name: "Decide" });
    fireEvent.click(within(decide).getByRole("button", { name: "Send back → Draft" }));
    expect(calls.some((call) => call.channel === "items:decide")).toBe(false);
    fireEvent.change(within(decide).getByRole("textbox", { name: "Why Send back" }), { target: { value: "The Q3 number is wrong." } });
    fireEvent.click(within(decide).getAllByRole("button", { name: "Send back → Draft" })[1]!);

    await waitFor(() => expect(payloadOf(calls, "items:decide")).toEqual({ itemId: "t1", resultKey: "send_back", comment: "The Q3 number is wrong." }));
  });

  it("keeps the typed reason in its box when the decision is refused (EO-562)", async () => {
    let refuse: (value: unknown) => void = () => {};
    const invoke = renderItem(detail({ decision: DECISION }));
    const answered = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel: string, payload: unknown) =>
      channel === "items:decide" ? new Promise<never>((resolve) => (refuse = resolve as (value: unknown) => void)) : answered(channel, payload),
    );

    const decide = await screen.findByRole("region", { name: "Decide" });
    fireEvent.click(within(decide).getByRole("button", { name: "Send back → Draft" }));
    fireEvent.change(within(decide).getByRole("textbox", { name: "Why Send back" }), { target: { value: "The Q3 number is wrong." } });
    const send = within(decide).getAllByRole("button", { name: "Send back → Draft" })[1]!;
    fireEvent.click(send);
    fireEvent.click(send);

    // On its way: every result waits, and the one pressed says so.
    await waitFor(() => expect(send).toHaveAttribute("aria-busy", "true"));
    expect(send).toBeDisabled();
    expect(within(decide).getByRole("button", { name: "Approve → Send" })).toBeDisabled();
    expect(invoke.mock.calls.filter(([channel]) => channel === "items:decide")).toHaveLength(1);

    await act(async () =>
      refuse({ ok: true, data: { decided: false, toStepId: null, toStepName: null, toPipelineId: null, commentId: null, problem: "An agent is working on this item right now." } }),
    );
    expect(await within(decide).findByText(/An agent is working on this item right now/)).toBeInTheDocument();
    expect(within(decide).getByRole("textbox", { name: "Why Send back" })).toHaveValue("The Q3 number is wrong.");
    expect(within(decide).getAllByRole("button", { name: "Send back → Draft" })[1]).toBeEnabled();
  });

  it("keeps the typed reason when the decision fails outright (EO-562)", async () => {
    const invoke = renderItem(detail({ decision: DECISION }));
    const answered = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel: string, payload: unknown) =>
      channel === "items:decide" ? ({ ok: false, error: { message: "The record could not be reached." } } as never) : answered(channel, payload),
    );

    const decide = await screen.findByRole("region", { name: "Decide" });
    fireEvent.click(within(decide).getByRole("button", { name: "Send back → Draft" }));
    fireEvent.change(within(decide).getByRole("textbox", { name: "Why Send back" }), { target: { value: "The Q3 number is wrong." } });
    fireEvent.click(within(decide).getAllByRole("button", { name: "Send back → Draft" })[1]!);

    expect(await within(decide).findByText("The record could not be reached.")).toBeInTheDocument();
    expect(within(decide).getByRole("textbox", { name: "Why Send back" })).toHaveValue("The Q3 number is wrong.");
  });

  it("shows the main process's refusal", async () => {
    renderItem(detail({ decision: DECISION }), undefined, {
      "items:decide": { decided: false, toStepId: null, toStepName: null, toPipelineId: null, commentId: null, problem: "An agent is working on this item right now." },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Approve → Send" }));
    expect(await screen.findByText(/An agent is working on this item right now/)).toBeInTheDocument();
  });
});

describe("deciding on a step that waits on a group (EO-368)", () => {
  const DECISION = [
    { key: "approved", label: "Approve", tone: "success" as const, requiresComment: false, targetName: "Send" },
    { key: "send_back", label: "Send back", tone: "warning" as const, requiresComment: true, targetName: "Draft" },
  ];
  const DESIGN = { id: "g-design", name: "Design" };
  const ANNA = { id: "p-anna", name: "Anna" };
  const authority = (you: "holder" | "member" | "outsider", holder: { id: string; name: string } | null) => ({
    "items:authority": { authority: { group: DESIGN, holder, you } },
  });

  it("offers the decision to the person holding the item", async () => {
    renderItem(detail({ decision: DECISION }), undefined, authority("holder", ANNA));

    const decide = await screen.findByRole("region", { name: "Decide" });
    expect(await within(decide).findByRole("button", { name: "Approve → Send" })).toBeInTheDocument();
    expect(within(decide).queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("shows a member who does not hold it who does, and Take over instead of the decision", async () => {
    renderItem(detail({ decision: DECISION }), undefined, authority("member", ANNA));

    const gate = await screen.findByRole("region", { name: "Who decides" });
    expect(gate).toHaveTextContent("Anna holds this");
    expect(within(gate).getByRole("button", { name: "Take over" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve → Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send back → Draft" })).toBeNull();
  });

  it("warns, naming the holder, and sends nothing until the takeover is confirmed", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail({ decision: DECISION }), onCall, {
      ...authority("member", ANNA),
      "items:takeOver": { assigneeId: "p-dana", assigneeName: "Dana", commentId: "c1", problem: null },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Take over" }));

    const warning = screen.getByRole("alertdialog", { name: "Take over from Anna" });
    expect(warning).toHaveTextContent("Anna is holding this");
    expect(calls.some((call) => call.channel === "items:takeOver")).toBe(false);

    fireEvent.click(within(warning).getByRole("button", { name: "Take over from Anna" }));
    await waitFor(() => expect(payloadOf(calls, "items:takeOver")).toEqual({ itemId: "t1", fromPersonId: "p-anna" }));
  });

  it("sends nothing when the warning is cancelled", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail({ decision: DECISION }), onCall, authority("member", ANNA));

    fireEvent.click(await screen.findByRole("button", { name: "Take over" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls.some((call) => call.channel === "items:takeOver")).toBe(false);
  });

  it("offers a member Claim on an item nobody holds, and no decision until they do", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail({ decision: DECISION }), onCall, {
      ...authority("member", null),
      "items:claim": { assigneeId: "p-dana", assigneeName: "Dana", commentId: "c1", problem: null },
    });

    const gate = await screen.findByRole("region", { name: "Who decides" });
    expect(screen.queryByRole("button", { name: "Approve → Send" })).toBeNull();
    fireEvent.click(within(gate).getByRole("button", { name: "Claim" }));
    await waitFor(() => expect(payloadOf(calls, "items:claim")).toEqual({ itemId: "t1" }));
  });

  it("shows somebody outside the group whose step it is, and nothing to press", async () => {
    renderItem(detail({ decision: DECISION }), undefined, authority("outsider", ANNA));

    const gate = await screen.findByRole("region", { name: "Who decides" });
    expect(gate).toHaveTextContent("This step waits on Design and Anna holds it");
    expect(within(gate).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve → Send" })).toBeNull();
  });

  it("offers the item's editors to the holder only, and leaves the reply box open to everybody", async () => {
    const output = { commentId: "o1", body: "Draft post.", format: "text" as const, authorName: "Writer", authorType: "agent" as const, createdAt: 100, attachments: [], supersedesCommentId: null };
    renderItem(detail({ decision: DECISION, currentOutput: output }), undefined, authority("member", ANNA));

    await screen.findByRole("region", { name: "Who decides" });
    expect(within(screen.getByRole("region", { name: "Output" })).getByRole("button", { name: "Edit" })).toBeDisabled();
    for (const box of screen.getAllByRole("textbox")) expect(box).toBeEnabled();
  });

  /**
   * `renderItem`, with the answer to `items:authority` in the test's hands
   * and the main process's pushes delivered on demand — so a test can hold
   * the answer back, or change it and say so the way a sync does.
   */
  function renderWithAuthority(answer: () => Promise<unknown>, onCall?: (channel: string, payload: unknown) => void) {
    const invoke = mockIpc(detail({ decision: DECISION }), onCall, {
      "items:takeOver": { assigneeId: "p-dana", assigneeName: "Dana", commentId: "c1", problem: null },
    });
    window.eo.ipc.invoke = (async (channel: string, payload: unknown) => {
      if (channel === "items:authority") {
        onCall?.(channel, payload);
        return { ok: true, data: await answer() };
      }
      return invoke(channel as never, payload as never);
    }) as never;
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set<(payload: unknown) => void>();
      set.add(callback);
      listeners.set(channel, set);
      return () => set.delete(callback);
    }) as never;
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={["/items/t1"]}>
            <ItemReferenceProvider>
              <ItemView itemId="t1" />
            </ItemReferenceProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    return {
      // A push about this item, as the main process sends one.
      push: (channel: string) =>
        act(async () => {
          listeners.get(channel)?.forEach((listener) => listener({ itemId: "t1" }));
          await Promise.resolve();
        }),
    };
  }

  it("draws no decision, Claim or Take over while it is still asking who decides", async () => {
    let answer: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => (answer = resolve));
    renderWithAuthority(() => pending);

    const decide = await screen.findByRole("region", { name: "Decide" });
    expect(within(decide).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve → Send" })).toBeNull();

    await act(async () => answer({ authority: { group: DESIGN, holder: ANNA, you: "outsider" } }));
    expect(await screen.findByRole("region", { name: "Who decides" })).toHaveTextContent("waits on Design");
    expect(screen.queryByRole("button", { name: "Approve → Send" })).toBeNull();
  });

  it("closes an open warning when the item changes hands, and never sends the new holder on the old confirmation", async () => {
    const { calls, onCall } = recorder();
    let holder = ANNA;
    const { push } = renderWithAuthority(async () => ({ authority: { group: DESIGN, holder, you: "member" } }), onCall);

    fireEvent.click(await screen.findByRole("button", { name: "Take over" }));
    expect(screen.getByRole("alertdialog", { name: "Take over from Anna" })).toBeInTheDocument();

    // A sync: Pat took it from Anna meanwhile.
    holder = { id: "p-pat", name: "Pat" };
    await push("items:changed");

    expect(await screen.findByText(/Anna no longer holds this — Pat does now/)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Take over from Anna" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Take over from Pat" })).toBeNull();
    expect(calls.some((call) => call.channel === "items:takeOver")).toBe(false);

    // A fresh warning, naming Pat, is what it takes now.
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Take over from Pat" })).getByRole("button", { name: "Take over from Pat" }));
    await waitFor(() => expect(payloadOf(calls, "items:takeOver")).toEqual({ itemId: "t1", fromPersonId: "p-pat" }));
  });

  it("changes nothing where nothing is gated", async () => {
    renderItem(detail({ decision: DECISION }), undefined, { "items:authority": { authority: null } });

    expect(await screen.findByRole("button", { name: "Approve → Send" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Who decides" })).toBeNull();
  });
});

describe("the output", () => {
  const TEXT = { commentId: "o1", body: "Your refund is on its way.", format: "text" as const, authorName: "Implementer", authorType: "agent" as const, createdAt: 100, attachments: [], supersedesCommentId: null };
  const file = (name: string) => ({ id: `at-${name}`, itemId: "t1", commentId: "o1", kind: "file" as const, name, mimeType: "application/octet-stream", size: 4096 });

  it("draws nothing where nothing was produced", async () => {
    renderItem(detail());
    await screen.findByRole("heading", { name: "Rate limit the API" });
    expect(screen.queryByRole("region", { name: "Output" })).toBeNull();
  });

  it("posts the corrected version through items:setOutput, and closes once it lands", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail({ currentOutput: TEXT }), onCall, { "items:setOutput": { commentId: "o2", supersededCommentId: "o1", problem: null } });

    const panel = await screen.findByRole("region", { name: "Output" });
    expect(within(panel).getByText(/Implementer/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Output" }), { target: { value: "Issued this morning." } });
    fireEvent.click(screen.getByRole("button", { name: "Save output" }));

    await waitFor(() => expect(payloadOf(calls, "items:setOutput")).toEqual({ itemId: "t1", body: "Issued this morning." }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Output" })).toBeNull());
  });

  it("keeps the editor open on a refusal", async () => {
    renderItem(detail({ currentOutput: TEXT }), undefined, { "items:setOutput": { commentId: null, supersededCommentId: null, problem: "An output cannot be empty." } });

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Output" }), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save output" }));
    expect(await screen.findByText(/An output cannot be empty/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Output" })).toHaveValue("   ");
  });

  it("does not offer to edit a diff", async () => {
    renderItem(detail({ currentOutput: { ...TEXT, format: "diff", body: "```diff\n+export const cap = 100;\n```" } }));
    const panel = await screen.findByRole("region", { name: "Output" });
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(panel).getByText(/\+export const cap = 100;/)).toBeInTheDocument();
  });

  it("copies the text, and exports it through the main process", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { calls, onCall } = recorder();
    renderItem(detail({ currentOutput: TEXT }), onCall, { "items:exportOutput": { saved: true, path: "/home/anna/refund.md", problem: null } });

    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Your refund is on its way."));
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(payloadOf(calls, "items:exportOutput")).toEqual({ itemId: "t1" }));
    expect(await screen.findByText(/Saved to \/home\/anna\/refund\.md/)).toBeInTheDocument();
  });

  it("exports a single file output as the file, and offers no Export for several", async () => {
    const { calls, onCall } = recorder();
    renderItem(detail({ currentOutput: { ...TEXT, format: "file", body: "- q3.docx", attachments: [file("q3.docx")] } }), onCall, { "attachments:save": { saved: true, problem: null } });

    const panel = await screen.findByRole("region", { name: "Output" });
    fireEvent.click(within(panel).getByRole("button", { name: "Export" }));
    await waitFor(() => expect(payloadOf(calls, "attachments:save")).toEqual({ attachmentId: "at-q3.docx" }));
  });

  it("offers no Export where several files leave nothing for it to mean", async () => {
    renderItem(detail({ currentOutput: { ...TEXT, format: "file", body: "- a\n- b", attachments: [file("q3.docx"), file("q3.csv")] } }));
    const panel = await screen.findByRole("region", { name: "Output" });
    expect(within(panel).queryByRole("button", { name: "Export" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Save q3.csv" })).toBeInTheDocument();
  });

  it("says where the version it replaced is", async () => {
    renderItem(detail({ currentOutput: { ...TEXT, supersedesCommentId: "o0" } }));
    expect(await screen.findByText(/still in the thread below/)).toBeInTheDocument();
  });
});

describe("a preview item", () => {
  it("wears the banner, and Done previewing deletes it with no dialog and leaves", async () => {
    const { calls, onCall } = recorder();
    const data = detail();
    data.item.preview = true;
    renderItem(data, onCall, { "items:delete": { deleted: true, deletedCount: 1, blockedByActiveRun: false, blockedByUncommittedWork: false, problem: null, jira: null, leftoverWorktrees: [] } });

    const banner = await screen.findByRole("note", { name: "Preview" });
    expect(within(banner).getByText("Preview. Nothing was sent, nothing cost money.")).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole("button", { name: "Done previewing" }));

    await waitFor(() => expect(screen.getByTestId("current-route")).toHaveTextContent(/^\/$/));
    expect(calls.filter((call) => call.channel === "items:delete").map((call) => call.payload)).toEqual([
      { itemId: "t1", cancelActiveRun: true, deleteInJira: false, discardUncommitted: true },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("draws no banner on real work", async () => {
    renderItem(detail());
    await screen.findByRole("heading", { name: "Rate limit the API" });
    expect(screen.queryByRole("note", { name: "Preview" })).toBeNull();
  });
});

/**
 * Another team's item, read by an admin through a server (EO-326, EO-319).
 *
 * The whole view is one fence, so every control on it is closed until
 * the admin says otherwise — and the machine's own affordances (Open,
 * Save, Export) are not offered at all, because a server has no machine.
 */
describe("an admin reading another team's item on a server", () => {
  afterEach(() => setBridge(undefined));

  function asAdminOnServer(data: ItemDetailData, replies: Record<string, unknown> = {}) {
    const invoke = mockIpc(data, undefined, replies);
    setBridge({
      invoke: (async (channel: string, payload: unknown) =>
        channel === "people:me"
          ? { ok: true, data: { person: { id: "u1", name: "Anna", email: null, isAdmin: true, invitedAt: null, acceptedAt: null, credentialKind: null }, admin: true, organisation: true } }
          : invoke(channel, payload)) as never,
      machineAvailable: false,
      subscribe: () => () => {},
      subscribeRefetch: () => () => {},
    });
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={["/items/t1"]}>
            <AdminAuthorityProvider>
              <ItemReferenceProvider>
                <ItemView itemId="t1" />
              </ItemReferenceProvider>
            </AdminAuthorityProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );
  }

  it("still reads back earlier comments behind the fence: reading is not writing (EO-559)", async () => {
    asAdminOnServer(detail({ comments: [comment({ id: "c2", body: "Newest word.", createdAt: 200 })], earlierComments: 1 }), {
      "items:earlierComments": { comments: [comment({ id: "c1", body: "First word.", createdAt: 100 })], earlier: 0 },
    });

    const more = await screen.findByRole("button", { name: "Show earlier comments (1)" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Pin comment" })).toBeDisabled());
    expect(more.matches(":disabled")).toBe(false);
    expect(more.closest("fieldset:disabled")).not.toBeNull();

    fireEvent.keyDown(more, { key: "Enter" });
    expect(await screen.findByText("First word.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show earlier comments/ })).toBeNull();
  });

  it("closes every control until the admin acts, then opens them", async () => {
    asAdminOnServer(detail({ comments: [comment()] }));

    await screen.findByRole("heading", { name: "Rate limit the API" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled();
    expect(screen.getByLabelText("Priority")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pin comment" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Act as admin" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled());
  });

  it("offers no Open, Save or Export where there is no machine", async () => {
    asAdminOnServer(
      detail({
        currentOutput: { commentId: "o1", body: "Done.", format: "text", authorName: "Implementer", authorType: "agent", createdAt: 1, attachments: [], supersedesCommentId: null },
        comments: [comment({ attachments: [{ id: "a1", itemId: "t1", commentId: "c1", kind: "file", name: "report.pdf", mimeType: "application/pdf", size: 10 }] })],
      }),
    );

    await screen.findByText("report.pdf");
    expect(screen.queryByRole("button", { name: "Open report.pdf" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save report.pdf" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete report.pdf" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});

/**
 * Long comments start clipped (EO-419).
 *
 * jsdom lays nothing out, so "long" is faked: a body whose text holds
 * LONG measures 400px, over the 360px threshold, and everything else
 * measures 100px.
 */
describe("collapsing long comments (EO-419)", () => {
  const LONG = "LONG report. It goes on.";
  let heights: { mockRestore: () => void } | null = null;

  function fakeHeights() {
    heights = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.textContent?.includes("LONG") ? 400 : 100;
    });
  }

  afterEach(() => {
    heights?.mockRestore();
    heights = null;
    setBridge(undefined);
  });

  /** The body a toggle clips, found the way assistive technology finds it. */
  function bodyOf(toggle: HTMLElement): HTMLElement {
    const body = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    if (!body) throw new Error("the toggle names no body");
    return body;
  }

  it("clips a long comment and leaves a short one as it was", async () => {
    fakeHeights();
    renderItem(detail({ comments: [comment({ id: "c1", body: LONG }), comment({ id: "c2", body: "Short note.", createdAt: 101 })] }));

    const toggle = await screen.findByRole("button", { name: "Show more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(bodyOf(toggle)).toHaveStyle({ maxHeight: `${COLLAPSED_HEIGHT_PX}px` });
    expect(bodyOf(toggle)).toHaveTextContent(LONG);

    // One toggle on the page: the short comment, the item's own body and
    // everything else above the thread are drawn in full.
    expect(screen.getAllByRole("button", { name: /^Show (more|less)$/ })).toHaveLength(1);
    expect(screen.getByText("Short note.").closest("[data-collapsed]")).toBeNull();
  });

  it("draws the item's body and its output in full however long they are", async () => {
    fakeHeights();
    const data = detail({
      currentOutput: { commentId: "o1", body: "LONG output.", format: "text", authorName: "Implementer", authorType: "agent", createdAt: 1, attachments: [], supersedesCommentId: null },
    });
    data.item.body = "LONG item body.";
    renderItem(data);

    await screen.findByText("LONG item body.");
    await screen.findAllByText("LONG output.");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("expands on Show more and clips again on Show less", async () => {
    fakeHeights();
    renderItem(detail({ comments: [comment({ body: LONG })] }));

    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    const toggle = screen.getByRole("button", { name: "Show less" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(bodyOf(toggle).style.maxHeight).toBe("");

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show more" })).toHaveAttribute("aria-expanded", "false");
    expect(bodyOf(toggle)).toHaveStyle({ maxHeight: `${COLLAPSED_HEIGHT_PX}px` });
  });

  it("clips a long reply too", async () => {
    fakeHeights();
    renderItem(
      detail({
        comments: [
          comment({ id: "c1", body: "Which rate limit?", kind: "question" }),
          comment({ id: "c2", body: LONG, authorType: "human", authorName: "Anna", parentId: "c1", createdAt: 101 }),
        ],
      }),
    );

    const toggle = await screen.findByRole("button", { name: "Show more" });
    expect(bodyOf(toggle)).toHaveTextContent(LONG);
    expect(bodyOf(toggle)).toHaveStyle({ maxHeight: `${COLLAPSED_HEIGHT_PX}px` });
    expect(screen.getAllByRole("button", { name: "Show more" })).toHaveLength(1);
  });

  it("starts a pinned question awaiting a reply collapsed, with everything around its body still there", async () => {
    fakeHeights();
    renderItem(
      detail({
        comments: [
          comment({
            body: LONG,
            kind: "question",
            awaitingHuman: true,
            pinned: true,
            options: ["Postgres", "SQLite"],
            attachments: [{ id: "a1", itemId: "t1", commentId: "c1", kind: "file", name: "report.pdf", mimeType: "application/pdf", size: 10 }],
          }),
        ],
      }),
    );

    const toggle = await screen.findByRole("button", { name: "Show more" });
    const body = bodyOf(toggle);
    expect(body).toHaveStyle({ maxHeight: `${COLLAPSED_HEIGHT_PX}px` });

    // Only the body is inside the clip.
    for (const outside of [
      screen.getByText("awaiting your reply"),
      screen.getByText("pinned"),
      screen.getByRole("button", { name: "Unpin comment" }),
      screen.getByRole("button", { name: "Delete comment" }),
      screen.getByText("report.pdf"),
      screen.getByRole("button", { name: "Reply" }),
      screen.getByRole("button", { name: "Postgres" }),
      screen.getByPlaceholderText("…or answer in your own words"),
    ]) {
      expect(body.contains(outside)).toBe(false);
      expect(outside).toBeEnabled();
    }
  });

  it("keeps an expanded comment expanded across a refetch, and collapses a long one that arrives", async () => {
    fakeHeights();
    let comments = [comment({ id: "c1", body: LONG })];
    const stored = vi.spyOn(Storage.prototype, "setItem");
    const { calls, onCall } = recorder();
    renderItem(detail(), onCall, { "items:get": () => detail({ comments }) });

    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
    // Expanding is the reader's own business: it reaches no channel and no storage.
    const before = calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(calls).toHaveLength(before);
    expect(stored).not.toHaveBeenCalled();
    stored.mockRestore();

    comments = [...comments, comment({ id: "c2", body: "Another LONG one, newest in the thread.", createdAt: 300 })];
    fireEvent.change(screen.getByLabelText("Write a comment"), { target: { value: "Thanks" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await screen.findByText("Another LONG one, newest in the thread.");
    expect(bodyOf(screen.getByRole("button", { name: "Show less" }))).toHaveTextContent(LONG);
    expect(bodyOf(screen.getByRole("button", { name: "Show more" }))).toHaveTextContent("Another LONG one");
  });

  it("collapses it again when the reader leaves the item and comes back", async () => {
    fakeHeights();
    const { unmount } = renderItem(detail({ comments: [comment({ body: LONG })] }));
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
    unmount();

    renderItem(detail({ comments: [comment({ body: LONG })] }));
    expect(await screen.findByRole("button", { name: "Show more" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show less" })).toBeNull();
  });

  it("lets a read-only reader expand and collapse, while Pin stays closed to them", async () => {
    fakeHeights();
    const invoke = mockIpc(detail({ comments: [comment({ body: LONG })] }));
    // An admin on a server reading another team's item, who has not pressed "Act as admin".
    setBridge({
      invoke: (async (channel: string, payload: unknown) =>
        channel === "people:me"
          ? { ok: true, data: { person: { id: "u1", name: "Anna", email: null, isAdmin: true, invitedAt: null, acceptedAt: null, credentialKind: null }, admin: true, organisation: true } }
          : invoke(channel, payload)) as never,
      machineAvailable: false,
      subscribe: () => () => {},
      subscribeRefetch: () => () => {},
    });
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={["/items/t1"]}>
            <AdminAuthorityProvider>
              <ItemReferenceProvider>
                <ItemView itemId="t1" />
              </ItemReferenceProvider>
            </AdminAuthorityProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );

    const toggle = await screen.findByRole("button", { name: "Show more" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Pin comment" })).toBeDisabled());
    // The fence disables form controls; the toggle is deliberately not one.
    expect(toggle.matches(":disabled")).toBe(false);
    expect(toggle.closest("fieldset:disabled")).not.toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    expect(bodyOf(toggle).style.maxHeight).toBe("");
    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Show more" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Pin comment" })).toBeDisabled();
  });
});

/**
 * A long thread, a page at a time (EO-559): `items:get` carries the
 * newest comments and how many came before them, and the rest is read
 * back with `items:earlierComments` when somebody asks.
 *
 * Against a small fake of the main process holding one thread, with a
 * page of two rather than a hundred, so that every refetch answers with
 * what the thread holds now — the only way to see that what is drawn
 * stays whole and true as it changes.
 */
describe("a thread longer than one page", () => {
  const PAGE = 2;
  type Deferred = { release: () => void };

  function fakeThread() {
    const thread = {
      comments: [
        comment({ id: "c0", body: "First word.", createdAt: 50 }),
        comment({ id: "c1", body: "Second word.", createdAt: 100 }),
        comment({ id: "c2", body: "Third word.", createdAt: 200 }),
        comment({ id: "c3", body: "Fourth word.", createdAt: 300 }),
        comment({ id: "c4", body: "Newest word.", createdAt: 400 }),
      ],
      /** Set to hold the next `items:earlierComments` answer until released. */
      hold: null as Deferred | null,
    };
    const all = () => [...thread.comments].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const base = detail({
      transitions: [transition({ id: "x-old", ts: 150, reason: "an early move" }), transition({ id: "x-new", fromStepId: "review", toStepId: "todo", ts: 350, reason: "a late move" })],
    });
    const replies = {
      "items:get": (payload: unknown) => {
        const { from } = payload as { from?: string };
        const ordered = all();
        const at = from === undefined ? -1 : ordered.findIndex((entry) => entry.id === from);
        const shown = at >= 0 ? ordered.slice(at) : ordered.slice(-PAGE);
        return { ...base, item: { ...base.item }, comments: shown, earlierComments: ordered.length - shown.length };
      },
      "items:earlierComments": (payload: unknown) => {
        const { before } = payload as { before: string };
        const answer = () => {
          const ordered = all();
          const at = ordered.findIndex((entry) => entry.id === before);
          if (at < 0) return { comments: [], earlier: 0 };
          const start = Math.max(0, at - PAGE);
          return { comments: ordered.slice(start, at), earlier: start };
        };
        const held = thread.hold;
        if (held === null) return answer();
        thread.hold = null;
        return new Promise((resolve) => {
          held.release = () => resolve(answer());
        });
      },
      "comments:post": (payload: unknown) => {
        const { body, parentId } = payload as { body: string; parentId: string | null };
        // Answering a question settles it, as the main process does.
        thread.comments = thread.comments.map((entry) => (entry.id === parentId ? { ...entry, awaitingHuman: false } : entry));
        thread.comments.push(comment({ id: `r${thread.comments.length}`, authorType: "human", authorName: "you", authorRole: null, body, parentId, createdAt: 1_000 + thread.comments.length }));
        return { commentId: "new", resumedRun: false, delivery: null };
      },
    };
    return { thread, replies, base };
  }

  /** Whatever the screen subscribed to `items:changed` with — an ordinary push, as the main process sends one. */
  function push() {
    const calls = (window.eo.ipc.subscribe as unknown as { mock: { calls: [string, (payload: unknown) => void][] } }).mock.calls;
    act(() => {
      for (const [channel, listener] of calls) if (channel === "items:changed") listener({ itemId: "t1" });
    });
  }

  const bodies = () => screen.getAllByText(/ word\.$/).map((element) => element.textContent);
  const asked = (calls: Calls, channel: string) => calls.filter((call) => call.channel === channel).map((call) => call.payload);

  it("draws the newest page with a control naming how many came before", async () => {
    const { replies, base } = fakeThread();
    renderItem(base, undefined, replies);

    expect(await screen.findByRole("button", { name: "Show earlier comments (3)" })).toBeInTheDocument();
    expect(bodies()).toEqual(["Fourth word.", "Newest word."]);
    // A move from before the oldest comment on screen waits for the
    // comments around it rather than sitting above the control.
    expect(screen.getByText(/a late move/)).toBeInTheDocument();
    expect(screen.queryByText(/an early move/)).toBeNull();
  });

  it("reads older pages back on demand, oldest first above the page, until there are none", async () => {
    const { calls, onCall } = recorder();
    const { replies, base } = fakeThread();
    renderItem(base, onCall, replies);

    fireEvent.click(await screen.findByRole("button", { name: "Show earlier comments (3)" }));
    expect(await screen.findByText("Third word.")).toBeInTheDocument();
    expect(screen.getByText(/an early move/)).toBeInTheDocument();
    // The page is held at its oldest comment, and history read before it.
    await waitFor(() => expect(asked(calls, "items:get")).toContainEqual({ itemId: "t1", from: "c3" }));
    expect(asked(calls, "items:earlierComments")).toEqual([{ itemId: "t1", before: "c3" }]);

    fireEvent.click(await screen.findByRole("button", { name: "Show earlier comments (1)" }));
    expect(await screen.findByText("First word.")).toBeInTheDocument();
    expect(asked(calls, "items:earlierComments")).toEqual([
      { itemId: "t1", before: "c3" },
      { itemId: "t1", before: "c1" },
    ]);
    expect(screen.queryByRole("button", { name: /Show earlier comments/ })).toBeNull();
    expect(bodies()).toEqual(["First word.", "Second word.", "Third word.", "Fourth word.", "Newest word."]);
  });

  it("offers no control when the page holds the whole thread", async () => {
    renderItem(detail({ comments: [comment()] }));
    await screen.findByText("Working on it.");
    expect(screen.queryByRole("button", { name: /Show earlier comments/ })).toBeNull();
  });

  it("misses nothing when the thread grows while the first page back is still being read", async () => {
    const { thread, replies, base } = fakeThread();
    const held: Deferred = { release: () => {} };
    thread.hold = held;
    renderItem(base, undefined, replies);

    fireEvent.click(await screen.findByRole("button", { name: "Show earlier comments (3)" }));
    expect(await screen.findByText("Reading earlier comments…")).toBeInTheDocument();
    // Before the answer lands, a comment arrives and the page is read
    // again: unheld, the page of two would now start at "Newest word."
    // and "Fourth word." would have slid into neither.
    thread.comments.push(comment({ id: "c5", body: "Latest word.", createdAt: 500 }));
    push();
    expect(await screen.findByText("Latest word.")).toBeInTheDocument();
    act(() => held.release());

    fireEvent.click(await screen.findByRole("button", { name: "Show earlier comments (1)" }));
    await screen.findByText("First word.");
    expect(screen.queryByRole("button", { name: /Show earlier comments/ })).toBeNull();
    expect(bodies()).toEqual(["First word.", "Second word.", "Third word.", "Fourth word.", "Newest word.", "Latest word."]);
  });

  it("settles an old question answered here, reading what was read back again", async () => {
    const { thread, replies, base } = fakeThread();
    thread.comments = thread.comments.map((entry) => (entry.id === "c1" ? { ...entry, kind: "question", options: ["Postgres", "SQLite"], awaitingHuman: true } : entry));
    renderItem(base, undefined, replies);

    fireEvent.click(await screen.findByRole("button", { name: "Show earlier comments (3)" }));
    const question = (await screen.findByText("Second word.")).closest("article")!;
    expect(within(question).getByText("awaiting your reply")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Postgres" }));
    await waitFor(() => expect(within(screen.getByText("Second word.").closest("article")!).queryByText("awaiting your reply")).toBeNull());
  });

  it("does not read history again on an ordinary push, and heals on the refetch backstop", async () => {
    const { calls, onCall } = recorder();
    const { thread, replies, base } = fakeThread();
    const client = createQueryClient();
    renderItem(base, onCall, replies, client);

    fireEvent.click(await screen.findByRole("button", { name: "Show earlier comments (3)" }));
    await screen.findByText("Third word.");
    expect(asked(calls, "items:earlierComments")).toHaveLength(1);

    // Deleted from another client: an ordinary push refreshes the page
    // and leaves what was read back alone, rather than resending it.
    thread.comments = thread.comments.filter((entry) => entry.id !== "c2");
    const pagesBefore = asked(calls, "items:get").length;
    push();
    await waitFor(() => expect(asked(calls, "items:get").length).toBeGreaterThan(pagesBefore));
    expect(asked(calls, "items:earlierComments")).toHaveLength(1);

    // The backstop — what a reconnect does to the whole cache, and what
    // focus does to whatever is stale — reads it again, cursor and all.
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(screen.queryByText("Third word.")).toBeNull());
    expect(asked(calls, "items:earlierComments").length).toBeGreaterThan(1);
    expect(bodies()).toEqual(["First word.", "Second word.", "Fourth word.", "Newest word."]);
    expect(screen.queryByRole("button", { name: /Show earlier comments/ })).toBeNull();
  });

  it("lets go of what was read back when the comment the page was held at is deleted, rather than draw a gap", async () => {
    const { thread, replies, base } = fakeThread();
    renderItem(base, undefined, replies);

    fireEvent.click(await screen.findByRole("button", { name: "Show earlier comments (3)" }));
    await screen.findByText("Third word.");

    thread.comments = thread.comments.filter((entry) => entry.id !== "c3");
    push();
    // The newest page again — "Third word." and "Newest word." — and its count.
    expect(await screen.findByRole("button", { name: "Show earlier comments (2)" })).toBeInTheDocument();
    expect(bodies()).toEqual(["Third word.", "Newest word."]);
  });
});

describe("the pushes the item page is read again for (EO-560)", () => {
  /** Every listener by channel, as the bridge holds them, so a push reaches what is subscribed now. */
  function listen() {
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set<(payload: unknown) => void>();
      set.add(callback);
      listeners.set(channel, set);
      return () => set.delete(callback);
    }) as never;
    return (channel: string, payload: unknown) =>
      act(async () => {
        listeners.get(channel)?.forEach((listener) => listener(payload));
        await Promise.resolve();
      });
  }

  const count = (calls: Calls, channel: string) => calls.filter((call) => call.channel === channel).length;
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

  it("reads the item again for its own pushes and item-less ones, never for another item's", async () => {
    const { calls, onCall } = recorder();
    mockIpc(detail(), onCall);
    const push = listen();
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={["/items/t1"]}>
            <ItemReferenceProvider>
              <ItemView itemId="t1" />
            </ItemReferenceProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    await screen.findByRole("heading", { name: "Rate limit the API" });
    await settle();
    expect(count(calls, "items:get")).toBe(1);

    // Another item's comment and another item's run: nothing on this page changed.
    await push("items:changed", { itemId: "t2" });
    await push("runs:changed", { runId: "r9", itemId: "t2", status: "succeeded" });
    await settle();
    expect(count(calls, "items:get")).toBe(1);
    expect(count(calls, "costs:getForItem")).toBe(1);

    await push("items:changed", { itemId: "t1" });
    await waitFor(() => expect(count(calls, "items:get")).toBe(2));
    await push("runs:changed", { runId: "r1", itemId: "t1", status: "succeeded" });
    await waitFor(() => expect(count(calls, "items:get")).toBe(3));
    expect(count(calls, "costs:getForItem")).toBe(2);
    // "Something changed", unnamed: still a refresh.
    await push("items:changed", {});
    await waitFor(() => expect(count(calls, "items:get")).toBe(4));
  });

  it("reads a story again when its feature changes, so an inherited Reference follows the feature's (EO-637)", async () => {
    const { calls, onCall } = recorder();
    let featureReference = "PROJ-123";
    const story = (): ItemDetailData => {
      const data = detail();
      data.item.parentId = "f1";
      data.item.parentKey = "EO-1";
      data.item.reference = { value: featureReference, inheritedFrom: "EO-1" };
      return data;
    };
    mockIpc(story(), onCall, { "items:get": () => story() });
    const push = listen();
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={["/items/t1"]}>
            <ItemReferenceProvider>
              <ItemView itemId="t1" />
            </ItemReferenceProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    const field = await screen.findByRole("region", { name: "Reference" });
    expect(field).toHaveTextContent("PROJ-123");
    expect(within(field).getByText("Inherited from EO-1")).toBeInTheDocument();
    await settle();

    // A sibling changing is nothing to this page.
    await push("items:changed", { itemId: "t2" });
    await settle();
    expect(count(calls, "items:get")).toBe(1);

    // The feature's Reference changed elsewhere — an agent, another window.
    featureReference = "PROJ-999";
    await push("items:changed", { itemId: "f1" });
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Reference" })).getByText("PROJ-999")).toBeInTheDocument());
    expect(within(screen.getByRole("region", { name: "Reference" })).getByText("Inherited from EO-1")).toBeInTheDocument();
  });

  it("asks items:list once for one items:changed, with the board and the item page both on screen", async () => {
    const { calls, onCall } = recorder();
    mockIpc(detail(), onCall, {
      "inbox:list": { items: [], summary: { openCount: 0, blockingCount: 0, everythingBlocked: false } },
      "items:authority": { authority: null },
    });
    const push = listen();
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={["/items/t1"]}>
            <ViewPublisher>
              <ItemReferenceProvider>
                <FrameListeners />
                <BoardView pipelineId="default" />
                <ItemView itemId="t1" />
              </ItemReferenceProvider>
            </ViewPublisher>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    await screen.findByRole("article", { name: "Rate limit the API" });
    await screen.findByRole("heading", { level: 2, name: "To Do" });
    await settle();
    const before = count(calls, "items:list");
    expect(before).toBe(1);

    await push("items:changed", { itemId: "t1" });
    await settle();
    expect(count(calls, "items:list")).toBe(before + 1);
    // The item page's own read and the archive the catalog joins, once each too.
    expect(count(calls, "items:listArchived")).toBe(2);
  });
});

/** What the window's frame listens on for the item list (`chat/ChatFrame.tsx`). */
function FrameListeners() {
  useInvalidateOnPush("items:changed", itemsKey);
  useInvalidateOnPush("runs:changed", itemsKey);
  return null;
}

describe("the item's own files (EO-702)", () => {
  const MOCK = { id: "f1", itemId: "t1", commentId: null, kind: "image" as const, name: "mock.png", mimeType: "image/png", size: 2048, syncStatus: "local" as const, syncError: null };
  const SPEC = { id: "f2", itemId: "t1", commentId: null, kind: "file" as const, name: "spec.pdf", mimeType: "application/pdf", size: 10, syncStatus: "local" as const, syncError: null };
  const SAID = { id: "f3", itemId: "t1", commentId: "c1", kind: "file" as const, name: "said.txt", mimeType: "text/plain", size: 3 };
  const free = { "items:authority": { authority: null } };

  function withFiles(files = [MOCK, SPEC]): ItemDetailData {
    const data = detail({ comments: [comment({ attachments: [SAID] })] });
    return { ...data, item: { ...data.item, attachments: files } };
  }

  let staged = 0;
  const staging = {
    ...free,
    "attachments:stage": (payload: unknown) => {
      const { name } = payload as { name: string };
      staged += 1;
      return { attachment: { id: `draft-${staged}`, kind: "file", name, mimeType: "text/plain", size: 1 } };
    },
    "items:addAttachments": { attachments: [], problem: null },
  };

  it("draws them under the description: an image as a thumbnail, anything else as a row that opens", async () => {
    const { calls, onCall } = recorder();
    renderItem(withFiles(), onCall, { ...free, "attachments:preview": { dataUrl: "data:image/png;base64,AAAA" } });

    const section = await screen.findByRole("region", { name: "Attachments" });
    expect(await within(section).findByRole("img", { name: "mock.png" })).toHaveAttribute("src", "data:image/png;base64,AAAA");
    fireEvent.click(within(section).getByRole("button", { name: "Open spec.pdf" }));
    await waitFor(() => expect(payloadOf(calls, "attachments:open")).toEqual({ attachmentId: "f2" }));
    // A comment's file stays on its comment, and is not offered for removal here.
    expect(within(section).queryByText("said.txt")).toBeNull();
    expect(within(section).queryByRole("button", { name: "Remove said.txt" })).toBeNull();
  });

  it("removes one only once the person has confirmed", async () => {
    const { calls, onCall } = recorder();
    renderItem(withFiles(), onCall, { ...free, "items:removeAttachment": { removed: true, problem: null } });

    const section = await screen.findByRole("region", { name: "Attachments" });
    fireEvent.click(await within(section).findByRole("button", { name: "Remove spec.pdf" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove this file?" });
    expect(dialog).toHaveTextContent("spec.pdf");
    expect(payloadOf(calls, "items:removeAttachment")).toBeUndefined();

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(payloadOf(calls, "items:removeAttachment")).toBeUndefined();

    fireEvent.click(within(section).getByRole("button", { name: "Remove spec.pdf" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove this file?" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(payloadOf(calls, "items:removeAttachment")).toEqual({ attachmentId: "f2" }));
  });

  it("puts dropped files on the item, and pasted ones", async () => {
    staged = 0;
    const { calls, onCall } = recorder();
    renderItem(withFiles([]), onCall, staging);

    const section = await screen.findByRole("region", { name: "Attachments" });
    fireEvent.drop(section, { dataTransfer: { files: [new File(["a"], "a.txt"), new File(["b"], "b.txt")] } });
    await waitFor(() => expect(payloadOf(calls, "items:addAttachments")).toEqual({ itemId: "t1", attachmentIds: ["draft-1", "draft-2"] }));

    fireEvent.paste(section, { clipboardData: { files: [new File(["c"], "shot.png")] } });
    await waitFor(() =>
      expect(calls.filter((call) => call.channel === "items:addAttachments").map((call) => call.payload)).toContainEqual({ itemId: "t1", attachmentIds: ["draft-3"] }),
    );
  });

  it("says which picked file main could not stage, in main's own sentence", async () => {
    const { calls, onCall } = recorder();
    renderItem(withFiles([]), onCall, {
      ...free,
      "attachments:pick": { attachments: [], omitted: 0, problem: "huge.bin is larger than the 20 MB attachment limit." },
    });

    const section = await screen.findByRole("region", { name: "Attachments" });
    fireEvent.click(within(section).getByRole("button", { name: "Add files" }));

    expect(await within(section).findByRole("alert")).toHaveTextContent("huge.bin is larger than the 20 MB attachment limit.");
    expect(payloadOf(calls, "items:addAttachments")).toBeUndefined();
  });

  it("refuses past eight in one go and a file over 20 MB, in the sentences a comment uses", async () => {
    staged = 0;
    const { calls, onCall } = recorder();
    renderItem(withFiles([]), onCall, staging);

    const section = await screen.findByRole("region", { name: "Attachments" });
    fireEvent.drop(section, { dataTransfer: { files: Array.from({ length: 9 }, (_unused, index) => new File(["x"], `f${index}.txt`)) } });
    expect(await within(section).findByRole("alert")).toHaveTextContent("A message can carry at most 8 files, so one was left out.");
    await waitFor(() => expect((payloadOf(calls, "items:addAttachments") as { attachmentIds: string[] } | undefined)?.attachmentIds).toHaveLength(8));

    const huge = new File(["x"], "huge.bin");
    Object.defineProperty(huge, "size", { value: 20 * 1024 * 1024 + 1 });
    fireEvent.drop(section, { dataTransfer: { files: [huge] } });
    expect(await within(section).findByText("huge.bin is larger than the 20 MB attachment limit.")).toBeInTheDocument();
  });
});
