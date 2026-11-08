import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { NO_GIT_STATE, type ItemSummary } from "@eo/core";
import { mountKeyOf } from "./ChatCanvas";
import { chatViewFor, movedAddressOf, tabKeyOf } from "./views/registry";
import { setBridge } from "../ipc/bridge";
import { THEME_STORAGE_KEY, setThemeChoice } from "./theme";

/**
 * The chat-centric layout — the window, and the only layout there is
 * (EO-529) — drawn as ARCHITECTURE.md, "The chat-centric layout",
 * describes it.
 *
 * The cases render the whole app, because what the layout claims is about
 * the whole window: the conversation survives navigation, every place in
 * the app opens beside it as a view of the layout's own, and an address
 * the window has no view for comes home to the conversation.
 *
 * The fixtures are two pipelines that are not the developer pack's,
 * because nothing here may assume delivery.
 */

const SYSTEM_AGENT = {
  id: "019fb8c6-de92-7a41-9c33-4471f0c2b100",
  name: "Assistant",
  role: "system",
  provider: "claude",
  model: null,
  enabled: true,
  archivedAt: null,
};

function message(overrides: Record<string, unknown>) {
  return {
    id: "m",
    authorType: "agent",
    authorName: "Assistant",
    body: "",
    attachments: [],
    kind: "note",
    parentId: null,
    runId: null,
    options: null,
    canAnswer: false,
    createdAt: 1,
    canApprove: false,
    approves: null,
    status: null,
    ...overrides,
  };
}

function conversation(messages: unknown[] = []) {
  return {
    id: "019fb8c6-de92-7a41-9c33-4471f0c2b1de",
    key: "ASK-1",
    startedAt: 0,
    closedAt: null,
    thinking: false,
    thinkingSince: null,
    liveOutput: "",
    liveActivity: [],
    settings: {
      agentId: SYSTEM_AGENT.id,
      agentName: "Assistant",
      provider: "claude",
      model: null,
      defaultModel: null,
      reasoningEffort: null,
      defaultReasoningEffort: null,
    },
    messages,
  };
}

const PIPELINES = [
  { id: "p-report", name: "Weekly report", icon: null, entryStepId: "s-gather", projectId: "proj", position: 0, archivedAt: null },
  { id: "p-invoices", name: "Vendor invoices", icon: null, entryStepId: "s-extract", projectId: "proj", position: 1, archivedAt: null },
];

function step(id: string, name: string, position: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    pipelineId: "p-report",
    position,
    name,
    type: "agent",
    ownerRole: "reporter",
    entryAction: null,
    instructionsSummary: null,
    isTerminal: false,
    planMode: false,
    results: [],
    ...overrides,
  };
}

const STEPS = [
  step("s-gather", "Gather", 0),
  step("s-draft", "Draft", 1),
  step("s-approve", "Approve", 2, { type: "user", ownerRole: null }),
  step("s-filed", "Filed", 3, { isTerminal: true }),
];

function route(id: string, fromStepId: string, label: string, target: string) {
  return { id, pipelineId: "p-report", fromStepId, resultKey: id, label, tone: "info", target, position: 0 };
}

const ROUTES = [
  route("r1", "s-gather", "Gathered", "s-draft"),
  route("r2", "s-gather", "Nothing to report", "user_attention"),
  route("r3", "s-draft", "Drafted", "s-approve"),
  route("r4", "s-approve", "Approve", "s-filed"),
  route("r5", "s-approve", "Send back", "s-draft"),
];

function item(overrides: Partial<ItemSummary>): ItemSummary {
  return {
    id: "i",
    key: "RPT-1",
    type: "report",
    typeLabel: "Report",
    container: false,
    parentId: null,
    parentKey: null,
    parentTitle: null,
    repositoryId: null,
    repositoryName: null,
    projectId: null,
    title: "Weekly report",
    pipelineId: "p-report",
    stepId: "s-draft",
    pipelineVersion: null,
    stepName: "Draft",
    progress: null,
    priority: 0,
    git: NO_GIT_STATE,
    workspace: { kind: "none", mode: "isolated", label: null },
    jiraKey: null,
    jiraUrl: null,
    updatedAt: 1,
    stepEnteredAt: 1,
    heldAt: null,
    origin: null,
    needsAttention: false,
    atTerminalStep: false,
    openDependencyCount: 0,
    latestRunStatus: null,
    assigneeName: null,
    assigneePerson: null,
    claimable: false,
    preview: false,
    ...overrides,
  };
}

const ITEMS = [
  item({ id: "i1", key: "RPT-7", title: "Week of 29 September", needsAttention: true, stepId: "s-approve", stepName: "Approve" }),
  item({ id: "i2", key: "INV-14", title: "Contoso licence renewal", pipelineId: "p-invoices", latestRunStatus: "running", stepName: "Extract" }),
  item({ id: "i3", key: "INV-11", title: "Fabrikam office lease", pipelineId: "p-invoices", stepName: "Approve", assigneePerson: { id: "anna", name: "Anna" } }),
];

const INBOX = {
  items: [
    {
      commentId: "c1",
      itemId: "i1",
      itemKey: "RPT-7",
      itemTitle: "Week of 29 September",
      itemTypeLabel: "Report",
      itemState: null,
      authorName: "reporter",
      body: "Ready for your approval.",
      kind: "question",
      options: null,
      createdAt: 1,
      blocking: true,
      waitingOn: { who: "you" },
      preview: false,
    },
  ],
  summary: { blockingCount: 1 },
};

const DETAIL = {
  item: {
    ...ITEMS[0],
    body: "Write it up for the leadership meeting on Monday.",
    acceptanceCriteria: ["What shipped", "What slipped and why"],
    typeKey: "report",
    spec: { period: "29 Sep – 5 Oct", audience: "Leadership", must_cover: ["What shipped", "What slipped and why"] },
    createdAt: 1,
  },
  decision: [
    { key: "approve", label: "Approve", tone: "success", requiresComment: false, targetName: "Filed" },
    { key: "send_back", label: "Send back", tone: "warning", requiresComment: true, targetName: "Draft" },
  ],
  currentOutput: null,
  comments: [],
  transitions: [],
  runs: [],
  dependsOn: [],
};

function bridge(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (channel: string, _payload?: unknown) => {
    if (channel in overrides) return { ok: true, data: overrides[channel] };
    switch (channel) {
      case "agents:list":
        return { ok: true, data: { agents: [SYSTEM_AGENT] } };
      case "assist:open":
        return { ok: true, data: { conversation: conversation() } };
      case "pipelines:list":
        return { ok: true, data: { pipelines: PIPELINES } };
      case "pipelineSteps:list":
        return { ok: true, data: { steps: STEPS, routes: ROUTES, entryStepId: "s-gather" } };
      case "items:list":
        return { ok: true, data: { items: ITEMS } };
      case "items:get":
        return { ok: true, data: DETAIL };
      case "inbox:list":
        return { ok: true, data: INBOX };
      default:
        return { ok: true, data: {} };
    }
  });
}

function open(path: string, invoke = bridge()) {
  window.eo.ipc.invoke = invoke as never;
  window.location.hash = `#${path}`;
  render(<App />);
  return invoke;
}

const rail = () => screen.getByRole("navigation", { name: "Main" });

/** What a pipeline drawing says of one route, as "label: from → to" — the marker repeats the end for the eye and is left out. */
const routeLine = (line: HTMLElement) => [...line.querySelectorAll(":scope > span:not([aria-hidden])")].map((part) => part.textContent).join("");

/** A place behind the rail's gear. */
async function morePlace(name: string) {
  fireEvent.click(within(await screen.findByRole("navigation", { name: "Main" })).getByRole("button", { name: "More places" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

afterEach(() => {
  window.localStorage.removeItem("eo.layout");
  window.localStorage.removeItem(THEME_STORAGE_KEY);
});

const rootColour = (name: string) => document.documentElement.style.getPropertyValue(name);

describe("which view an address names", () => {
  it("draws every place in the app as a view of its own, at the address it has always had", () => {
    expect(chatViewFor("/pipelines/p1", "")).toEqual({ kind: "board", pipelineId: "p1" });
    expect(chatViewFor("/pipelines/p1", "?view=graph")).toEqual({ kind: "graph", pipelineId: "p1" });
    // A board another screen narrowed is still the board, which reads the narrowing itself.
    expect(chatViewFor("/pipelines/p1", "?step=s1")).toEqual({ kind: "board", pipelineId: "p1" });
    // The editor's address opens what the pipeline is, read-only (EO-525): pipelines change through the assistant.
    expect(chatViewFor("/pipelines/p1/configure", "")).toEqual({ kind: "graph", pipelineId: "p1" });
    expect(chatViewFor("/pipelines/p1/configure", "?changes")).toEqual({ kind: "graph", pipelineId: "p1" });
    expect(movedAddressOf("/pipelines/p1/configure")).toBe("/pipelines/p1?view=graph");
    expect(movedAddressOf("/pipelines/p1/configure/")).toBe("/pipelines/p1?view=graph");
    expect(movedAddressOf("/pipelines/p1")).toBeNull();
    expect(movedAddressOf("/pipelines/p1/changes")).toBeNull();
    // The read-only Changes view at its own address (EO-524), which reads what it compares itself.
    expect(chatViewFor("/pipelines/p1/changes", "")).toEqual({ kind: "changes", pipelineId: "p1" });
    expect(chatViewFor("/pipelines/p1/changes", "?from=2&to=3")).toEqual({ kind: "changes", pipelineId: "p1" });
    expect(chatViewFor("/pipelines/p1/changes/", "?local")).toEqual({ kind: "changes", pipelineId: "p1" });
    expect(chatViewFor("/project", "")).toMatchObject({ kind: "board" });
    expect(chatViewFor("/items/i1", "")).toEqual({ kind: "item", itemId: "i1" });
    expect(chatViewFor("/items/i1/runs", "")).toEqual({ kind: "runs", itemId: "i1" });
    expect(chatViewFor("/jobs/j1", "")).toEqual({ kind: "job", jobId: "j1" });
    for (const [path, kind] of [
      ["/items", "items"],
      ["/inbox", "inbox"],
      ["/mentions", "mentions"],
      ["/archive", "archive"],
      ["/jobs", "jobs"],
      ["/gallery", "gallery"],
      ["/agents", "agents"],
      ["/agent-tools", "agentTools"],
      ["/settings", "settings"],
    ] as const) {
      expect(chatViewFor(path, ""), path).toMatchObject({ kind });
    }
    // A proposed item, by the card's message and its place among the rows (EO-408).
    expect(chatViewFor("/proposals/m1/2", "")).toEqual({ kind: "proposedItem", messageId: "m1", index: 2 });
    expect(chatViewFor("/proposals/m1/second", "")).toBeNull();
    expect(chatViewFor("/proposals/m1", "")).toBeNull();
    // The home, and an address nothing draws — Discussions among them:
    // planning is something said in the conversation, the layout's one room.
    expect(chatViewFor("/chat", "")).toBeNull();
    expect(chatViewFor("/nowhere", "")).toBeNull();
    expect(chatViewFor("/discussions", "")).toBeNull();
    expect(chatViewFor("/discussions/c1", "")).toBeNull();
  });

  it("keeps one tab for one thing, however many ways it is seen", () => {
    const tab = (path: string, search = "") => tabKeyOf(chatViewFor(path, search)!);
    expect(tab("/pipelines/p1")).toBe(tab("/pipelines/p1", "?view=graph"));
    expect(tab("/pipelines/p1")).toBe(tab("/pipelines/p1/configure"));
    expect(tab("/pipelines/p1")).toBe(tab("/pipelines/p1/changes", "?from=1&to=2"));
    expect(tab("/items/i1")).toBe(tab("/items/i1/runs"));
    expect(tab("/pipelines/p1")).not.toBe(tab("/pipelines/p2"));
  });

  it("gives each proposed item a tab of its own", () => {
    const tab = (path: string) => tabKeyOf(chatViewFor(path, "")!);
    expect(tab("/proposals/m1/0")).toBe(tab("/proposals/m1/0/"));
    expect(tab("/proposals/m1/0")).not.toBe(tab("/proposals/m1/1"));
    expect(tab("/proposals/m1/0")).not.toBe(tab("/proposals/m2/0"));
    // Not an item's tab: an item is opened by its id, and this has none.
    expect(tab("/proposals/m1/0")).not.toBe(tab("/items/m1"));
  });
});

/**
 * There was a second layout, chosen per device in `eo.layout` (EO-529
 * removed it). Whatever a device remembered, the window is this one.
 */
describe("a window, whatever layout it once chose", () => {
  it.each([["nothing", null], ["the classic layout", "classic"], ["the chat layout", "chat"]] as const)(
    "opens on the conversation for a device that remembered %s",
    async (_remembered, stored) => {
      if (stored !== null) window.localStorage.setItem("eo.layout", stored);
      open("/");
      await waitFor(() => expect(window.location.hash).toBe("#/chat"));
      expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
      expect(await screen.findByRole("textbox", { name: "Message the assistant" })).toBeInTheDocument();
    },
  );

  it("opens the board the classic layout opened on as the chat layout's board", async () => {
    window.localStorage.setItem("eo.layout", "classic");
    open("/project");
    await screen.findByRole("region", { name: "Canvas" });
    expect(window.location.hash).toBe("#/project");
    expect(screen.getByRole("region", { name: "Conversation" })).toBeInTheDocument();
  });

  it("sends the assistant's old window address to the conversation, with no window of its own (EO-529)", async () => {
    open("/assist");
    await waitFor(() => expect(window.location.hash).toBe("#/chat"));
    expect(await screen.findByRole("textbox", { name: "Message the assistant" })).toBeInTheDocument();
    expect(rail()).toBeInTheDocument();
  });
});

describe("the chat layout's home", () => {
  it("opens on the conversation, with what is waiting, working and with others beside it", async () => {
    open("/");

    await waitFor(() => expect(window.location.hash).toBe("#/chat"));
    const conversationColumn = await screen.findByRole("region", { name: "Conversation" });
    expect(await within(conversationColumn).findByRole("textbox", { name: "Message the assistant" })).toBeInTheDocument();

    const overview = await screen.findByRole("region", { name: "Overview" });
    expect(await within(overview).findByText("Week of 29 September")).toBeInTheDocument();
    expect(within(overview).getByText("Weekly report · Approve")).toBeInTheDocument();
    expect(within(overview).getByText(/Contoso licence renewal/)).toBeInTheDocument();
    expect(within(overview).getByText("Anna · Approve")).toBeInTheDocument();
  });

  // EO-430: the inbox is the Inbox, the rail's count and the Overview's list —
  // not a card under the assistant's newest turn, which read as its own words.
  it.each([
    ["on the home", "/chat"],
    ["beside a canvas view", "/pipelines/p-report"],
  ])("draws nothing from the inbox in the conversation %s, while a decision waits on you", async (_where, path) => {
    open(path);

    const column = await screen.findByRole("region", { name: "Conversation" });
    await within(column).findByRole("textbox", { name: "Message the assistant" });
    // The inbox has been read, and holds a blocking row: the rail counts it.
    expect(await within(rail()).findByText("1 waiting on you")).toBeInTheDocument();

    expect(screen.queryByRole("article", { name: "RPT-7 needs you" })).not.toBeInTheDocument();
    expect(within(column).queryByText(/Ready for your approval\./)).not.toBeInTheDocument();
    expect(within(column).queryByText(/Week of 29 September/)).not.toBeInTheDocument();
    expect(within(column).queryByRole("button", { name: "Approve → Filed" })).not.toBeInTheDocument();
  });

  it("ends a draft's hand-off at a marker naming the pipeline it goes to, on a draft that creates a pipeline too", async () => {
    const draft = message({ id: "d1", body: "Here is the pipeline.", canApprove: true, approves: "pipeline" });
    const steps = [step("n-build", "Build", 0, { pipelineId: "" }), step("n-ship", "Ship", 1, { pipelineId: "", isTerminal: true })];
    const routes = [route("n1", "n-build", "Built", "n-ship"), route("n2", "n-build", "Needs a report", "s-draft"), route("n3", "n-build", "Lost", "nowhere")];
    open(
      "/chat",
      bridge({
        "assist:open": { conversation: conversation([draft]) },
        "assist:draft": { pipelineId: null, newPipelineName: "Release", steps, routes, entryStepId: "n-build", problem: null },
      }),
    );

    const card = await screen.findByRole("region", { name: "Pipeline draft" });
    await within(card).findByRole("list", { name: "Pipeline graph" });
    // A new pipeline's steps are all new, so none is marked as such (EO-680).
    expect(card.querySelectorAll("[data-new-step]")).toHaveLength(0);
    // The project's pipelines are asked for as one of them: there is no id to ask with yet.
    await waitFor(() =>
      expect(within(within(card).getByRole("list", { name: "Routes" })).getAllByRole("listitem").map(routeLine)).toEqual([
        "Built: Build → Ship",
        `Needs a report: Build → ${PIPELINES[0]!.name} · Draft`,
      ]),
    );
  });

  it("draws a drafted pipeline as its steps and owners, and publishes it on one path", async () => {
    const draft = message({ id: "d1", body: "Here is the pipeline.", canApprove: true, approves: "pipeline" });
    const invoke = open(
      "/chat",
      bridge({
        "assist:open": { conversation: conversation([draft]) },
        "assist:draft": { pipelineId: "p-report", steps: STEPS, routes: ROUTES, entryStepId: "s-gather", problem: null },
        "pipeline:save": { saved: true, problems: [] },
      }),
    );

    const card = await screen.findByRole("region", { name: "Pipeline draft" });
    const steps = await within(card).findByRole("list", { name: "Pipeline graph" });
    expect(within(steps).getByText("Gather")).toBeInTheDocument();
    // Each step's kind is a chip, its owner line the chip's title (EO-680).
    expect(within(steps).getAllByTitle("agent · reporter").map((chip) => chip.textContent)).toEqual(["agent", "agent"]);
    expect(within(steps).getByTitle("you")).toHaveTextContent("person");
    expect(within(within(steps).getByText("Gather").closest("li")!).getByText("start")).toBeInTheDocument();
    expect(within(within(steps).getByText("Filed").closest("li")!).getByText("end")).toBeInTheDocument();
    // Every route is an arrow with its result on it, not a chip in a list underneath.
    const routes = within(card).getByRole("list", { name: "Routes" });
    expect(within(routes).getAllByRole("listitem").map(routeLine)).toEqual([
      "Gathered: Gather → Draft",
      "Nothing to report: Gather → you",
      "Drafted: Draft → Approve",
      "Approve: Approve → Filed",
      "Send back: Approve → Draft",
    ]);
    expect(card.querySelectorAll("[data-route]")).toHaveLength(5);

    fireEvent.click(within(card).getByRole("button", { name: "Publish pipeline" }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "Published" })).toBeDisabled());
    expect(invoke.mock.calls.filter(([channel]) => channel === "pipeline:save")).toHaveLength(1);
  });

  it("marks the steps a draft adds to an existing pipeline, and only those (EO-680)", async () => {
    const draft = message({ id: "d1", body: "Adds a check by hand.", canApprove: true, approves: "pipeline" });
    const steps = [...STEPS.slice(0, 3), step("s-check", "Check by hand", 3, { type: "user", ownerRole: null }), { ...STEPS[3]!, position: 4 }];
    open(
      "/chat",
      bridge({
        "assist:open": { conversation: conversation([draft]) },
        "assist:draft": { pipelineId: "p-report", steps, routes: ROUTES, entryStepId: "s-gather", problem: null },
      }),
    );

    const card = await screen.findByRole("region", { name: "Pipeline draft" });
    const graph = await within(card).findByRole("list", { name: "Pipeline graph" });
    // Marked once the pipeline as published has been read: "Check by hand" is the one step it has not got.
    await waitFor(() => expect([...graph.querySelectorAll("[data-new-step]")].map((box) => box.getAttribute("data-step"))).toEqual(["s-check"]));
    const added = graph.querySelector('[data-step="s-check"]') as HTMLElement;
    expect(within(added).getByText("new")).toBeInTheDocument();
    expect(added.className).toContain("border-dashed");
    expect(added.className).toContain("border-ink-muted");
    // In the neutral ink, never the accent: a new step is not something to press.
    expect(added.className).not.toMatch(/accent/);
    expect(within(graph).getAllByText("new")).toHaveLength(1);
    for (const id of ["s-gather", "s-draft", "s-approve", "s-filed"]) {
      expect((graph.querySelector(`[data-step="${id}"]`) as HTMLElement).className, id).not.toContain("border-dashed");
    }
  });

  // EO-520: a draft that restores a version and renames the pipeline says
  // so on the card, and its Publish sends the version to `pipeline:save`
  // and the name and icon to `pipelines:update` once the graph has saved.
  it("marks a restored version on the card, and publishes it with its owners, its name and its icon", async () => {
    const draft = message({ id: "d1", body: "Back to v2.", canApprove: true, approves: "pipeline" });
    const invoke = open(
      "/chat",
      bridge({
        "assist:open": { conversation: conversation([draft]) },
        "assist:draft": { pipelineId: "p-report", steps: STEPS, routes: ROUTES, entryStepId: "s-gather", problem: null, restoredFrom: 2, rename: "Reports", icon: "boxes" },
        "pipeline:save": { saved: true, problems: [] },
        "pipelines:update": { pipeline: { ...PIPELINES[0]!, name: "Reports", icon: "boxes" } },
      }),
    );

    const card = await screen.findByRole("region", { name: "Pipeline draft" });
    expect(await within(card).findByText("restores v2")).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Publish pipeline" }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "Published" })).toBeDisabled());
    const sent = (name: string) => invoke.mock.calls.filter(([channel]) => channel === name).map(([, payload]) => payload);
    expect(sent("pipeline:save")).toEqual([expect.objectContaining({ pipelineId: "p-report", restoredFrom: 2 })]);
    expect(sent("pipelines:update")).toEqual([{ id: "p-report", name: "Reports", icon: "boxes" }]);
    // After the graph saved, never before it.
    const order = invoke.mock.calls.map(([channel]) => channel);
    expect(order.indexOf("pipelines:update")).toBeGreaterThan(order.indexOf("pipeline:save"));
  });

  // EO-534: a draft from the chat that holds a template update conflict
  // says it was published once the graph has saved, which is what
  // resolves the conflict — and an ordinary draft says nothing.
  it("tells the main process a conflict chat's draft was published, after the graph saved, and nothing for an ordinary draft", async () => {
    const draft = message({ id: "d1", body: "Keeps your merge and adds autofix.", canApprove: true, approves: "pipeline" });
    const invoke = open(
      "/chat",
      bridge({
        "assist:open": { conversation: conversation([draft]) },
        "assist:draft": { pipelineId: "p-report", steps: STEPS, routes: ROUTES, entryStepId: "s-gather", problem: null, updateConflictId: "conflict-1" },
        "pipeline:save": { saved: true, problems: [] },
        "assist:draftPublished": { resolved: true, problem: null },
      }),
    );

    const card = await screen.findByRole("region", { name: "Pipeline draft" });
    await within(card).findByRole("list", { name: "Pipeline graph" });
    fireEvent.click(within(card).getByRole("button", { name: "Publish pipeline" }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "Published" })).toBeDisabled());

    const sent = (name: string) => invoke.mock.calls.filter(([channel]) => channel === name).map(([, payload]) => payload);
    expect(sent("assist:draftPublished")).toEqual([{ conversationId: expect.any(String), messageId: "d1" }]);
    const order = invoke.mock.calls.map(([channel]) => channel);
    expect(order.indexOf("assist:draftPublished")).toBeGreaterThan(order.indexOf("pipeline:save"));
  });

  it("says nothing about a conflict for a draft that resolves none", async () => {
    const draft = message({ id: "d1", body: "Here.", canApprove: true, approves: "pipeline" });
    const invoke = open(
      "/chat",
      bridge({
        "assist:open": { conversation: conversation([draft]) },
        "assist:draft": { pipelineId: "p-report", steps: STEPS, routes: ROUTES, entryStepId: "s-gather", problem: null },
        "pipeline:save": { saved: true, problems: [] },
      }),
    );

    const card = await screen.findByRole("region", { name: "Pipeline draft" });
    await within(card).findByRole("list", { name: "Pipeline graph" });
    fireEvent.click(within(card).getByRole("button", { name: "Publish pipeline" }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "Published" })).toBeDisabled());
    expect(invoke.mock.calls.filter(([channel]) => channel === "assist:draftPublished")).toEqual([]);
  });

  it("renames nothing when the graph it was published with is refused", async () => {
    const draft = message({ id: "d1", body: "Renamed.", canApprove: true, approves: "pipeline" });
    const invoke = open(
      "/chat",
      bridge({
        "assist:open": { conversation: conversation([draft]) },
        "assist:draft": { pipelineId: "p-report", steps: STEPS, routes: ROUTES, entryStepId: "s-gather", problem: null, rename: "Reports" },
        "pipeline:save": { saved: false, problems: [{ severity: "error", stateId: null, message: "No terminal step." }] },
      }),
    );

    const card = await screen.findByRole("region", { name: "Pipeline draft" });
    fireEvent.click(await within(card).findByRole("button", { name: "Publish pipeline" }));
    expect(await within(card).findByText("No terminal step.")).toBeInTheDocument();
    expect(invoke.mock.calls.some(([channel]) => channel === "pipelines:update")).toBe(false);
  });

  // EO-450: what a drafted step holds that only exists on this machine is
  // listed on the card by step and field, and Publish goes through anyway.
  it("lists the machine-specific values in a drafted pipeline's steps, and publishes it anyway", async () => {
    const draft = message({ id: "d1", body: "Here is the pipeline.", canApprove: true, approves: "pipeline" });
    const steps = [
      step("s-gather", "Gather", 0, { instructionsSummary: "Read the reports in /Users/anna/reports." }),
      step("s-draft", "Draft", 1, { inputs: { endpoint: "http://localhost:4000", branch: "main" } }),
      ...STEPS.slice(2),
    ];
    const invoke = open(
      "/chat",
      bridge({
        "assist:open": { conversation: conversation([draft]) },
        "assist:draft": { pipelineId: "p-report", steps, routes: ROUTES, entryStepId: "s-gather", problem: null },
        "pipeline:save": { saved: true, problems: [] },
      }),
    );

    const card = await screen.findByRole("region", { name: "Pipeline draft" });
    const note = await within(card).findByRole("note", { name: "Machine-specific values" });
    expect(note).toHaveTextContent('step "Gather" instructions summary: /Users/anna/reports.');
    expect(note).toHaveTextContent('step "Draft" input "endpoint": localhost:4000');

    fireEvent.click(within(card).getByRole("button", { name: "Publish pipeline" }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "Published" })).toBeDisabled());
    expect(invoke.mock.calls.filter(([channel]) => channel === "pipeline:save")).toHaveLength(1);
  });

  // EO-398: a module the assistant wrote on its own is a card, read from
  // the catalog, and reading its code does not leave the conversation.
  it("draws a proposed module as a card, and opens its code over the conversation without navigating", async () => {
    const module = {
      id: "mod-1",
      slug: "release-merge",
      name: "Release merge",
      description: "Merges the release branch once CI is green.",
      code: "export default async () => ({ ok: true, result: 'merged' });",
      manifest: { name: "Release merge", description: "Merges.", inputs: {}, needs: { bin: ["gh"], env: [], network: true, item: false, comment: false, attach: false, create: false }, results: ["merged"] },
      originalScript: null,
      source: "architect",
      approvedAt: null,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      usedByStepCount: 0,
      portability: [],
      machineSpecific: [],
      testRun: null,
      testsStale: false,
      testCount: 1,
    };
    const card = message({ id: "c1", kind: "decision", body: "**New module** Release merge", canApprove: true, approves: "module", moduleSlug: "release-merge" });
    open(
      "/chat",
      bridge({
        "assist:open": { conversation: conversation([card]) },
        "modules:list": { modules: [module] },
        "moduleTests:list": { tests: [], problem: null },
      }),
    );

    const proposal = await screen.findByRole("region", { name: "Module proposal" });
    expect(await within(proposal).findByText("Release merge")).toBeInTheDocument();
    expect(within(proposal).getByText("Not approved")).toBeInTheDocument();
    // Not the work card: nothing here creates anything on a board.
    expect(screen.queryByRole("region", { name: "Proposal" })).not.toBeInTheDocument();

    const before = window.location.hash;
    fireEvent.click(within(proposal).getByRole("button", { name: "View code" }));
    const dialog = await screen.findByRole("dialog", { name: "Release merge" });
    expect(within(dialog).getByLabelText("Code of Release merge")).toHaveTextContent("result: 'merged'");
    expect(window.location.hash).toBe(before);
    // The conversation is still there behind it.
    expect(screen.getByRole("region", { name: "Module proposal" })).toBeInTheDocument();
  });

  // EO-418: a change to a module that exists is its own card — a diff
  // with Apply — and never the work card, whose button creates work.
  it("draws a change to an existing module as a card with Apply, applied through assist:applyChange", async () => {
    const card = message({
      id: "c1",
      kind: "decision",
      body: "**Proposed change to Release merge** (`release-merge`)\n\nDrops two variables.",
      canApprove: true,
      approves: "moduleChange",
      moduleChange: { moduleId: "mod-1", applied: false, describesSaved: false },
    });
    const invoke = bridge({
      "assist:open": { conversation: conversation([card]) },
      "modules:list": { modules: [] },
      "assist:applyChange": { applied: true, problem: null, conversation: conversation([card]) },
    });
    open("/chat", invoke);

    const change = await screen.findByRole("region", { name: "Proposed module change" });
    expect(within(change).getByText(/Drops two variables/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Proposal" })).not.toBeInTheDocument();

    fireEvent.click(within(change).getByRole("button", { name: "Apply change" }));

    await waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === "assist:applyChange")).toBe(true));
    expect(invoke.mock.calls.some(([channel]) => channel === "assist:approve")).toBe(false);
  });

  // EO-521: something only a person may do is its own card — here a
  // delete — and never the work card, whose button creates work.
  it("draws a card for deleting a pipeline, pressed through assist:applyCard", async () => {
    const card = message({
      id: "c1",
      kind: "decision",
      body: "**Delete** Delivery.",
      canApprove: true,
      approves: "card",
      card: { kind: "pipelineDelete", outcome: null },
    });
    const invoke = bridge({
      "assist:open": { conversation: conversation([card]) },
      "assist:card": { card: { kind: "pipelineDelete", pipelineId: "delivery", pipelineName: "Delivery", itemCount: 2 }, problem: null },
      "assist:applyCard": { applied: true, problem: null, said: "Deleted Delivery.", conversation: conversation([card]) },
    });
    open("/chat", invoke);

    const region = await screen.findByRole("region", { name: "Delete a pipeline" });
    expect(await within(region).findByText(/Delivery holds 2/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Proposal" })).not.toBeInTheDocument();

    fireEvent.click(within(region).getByRole("button", { name: "Delete pipeline" }));

    await waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === "assist:applyCard")).toBe(true));
    expect(invoke.mock.calls.some(([channel]) => channel === "assist:approve" || channel === "pipelines:delete")).toBe(false);
  });

  // EO-407: the work a turn proposes is one card of compact rows, drawn
  // from the structured proposal on the message, never from the prose.
  describe("a proposal for new work", () => {
    const row = (title: string, waitsOn: { key: string | null; title: string }[] = []) => ({
      kind: "new",
      title,
      typeLabel: "Section",
      acceptanceCriteria: [`${title} is covered`, "It cites its source"],
      waitsOn,
      under: null,
    });
    const PLAN = {
      container: { title: "Quarterly review", typeLabel: "Report" },
      rows: [row("What shipped"), row("What slipped", [{ key: null, title: "What shipped" }]), row("What is next")],
      closed: null,
    };
    const BODY = "**Quarterly review** — a new report.\n\nSTORY-BODY one.\n\nSTORY-BODY two.\n\nSTORY-BODY three.";
    const said = message({ id: "n1", body: "Here is the review as three sections." });

    it("draws the container's title and one row per item, with the assistant's sentence above and no body text", async () => {
      const card = message({ id: "p1", kind: "decision", body: BODY, createdAt: 2, canApprove: true, approves: "items", proposal: PLAN });
      const invoke = open(
        "/chat",
        bridge({
          "assist:open": { conversation: conversation([said, card]) },
          "assist:approve": { applied: true, problem: null, createdKeys: ["RPT-8", "RPT-9", "RPT-10", "RPT-11"], changedKeys: [], conversation: conversation([said]) },
        }),
      );

      const proposal = await screen.findByRole("region", { name: "Proposal" });
      expect(within(proposal).getByText("Quarterly review")).toBeInTheDocument();
      const rows = within(proposal).getAllByRole("listitem");
      expect(rows).toHaveLength(3);
      expect(within(rows[0]!).getByText("Section")).toBeInTheDocument();
      expect(within(rows[0]!).getByText("What shipped is covered")).toBeInTheDocument();
      expect(within(rows[0]!).getByText("+1 more")).toBeInTheDocument();
      expect(within(rows[1]!).getByText("Waits on What shipped")).toBeInTheDocument();
      // What the assistant said is still its own turn, above the card.
      const transcript = screen.getByLabelText("Assistant transcript");
      expect(within(transcript).getByText("Here is the review as three sections.")).toBeInTheDocument();
      expect(transcript).not.toHaveTextContent("STORY-BODY");

      // One button, for the whole proposal.
      fireEvent.click(within(proposal).getByRole("button", { name: /^Create / }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:approve", { conversationId: conversation().id, messageId: "p1" }));
      expect(invoke.mock.calls.filter(([channel]) => channel === "assist:approve")).toHaveLength(1);
    });

    it("keeps the rows of one that can no longer be approved, without the button", async () => {
      const card = message({ id: "p1", kind: "decision", body: BODY, createdAt: 2, proposal: { ...PLAN, closed: "superseded" } });
      open("/chat", bridge({ "assist:open": { conversation: conversation([said, card]) } }));

      const proposal = await screen.findByRole("region", { name: "Proposal" });
      expect(within(proposal).getAllByRole("listitem")).toHaveLength(3);
      expect(within(proposal).queryByRole("button")).not.toBeInTheDocument();
      expect(within(proposal).getByText("Replaced by a newer proposal.")).toBeInTheDocument();
      expect(screen.getByLabelText("Assistant transcript")).not.toHaveTextContent("STORY-BODY");
    });

    it("links an amendment's row to the item it changes", async () => {
      const change = { container: null, rows: [{ kind: "change", itemId: "i1", itemKey: "RPT-7", itemTitle: "Week of 29 September", change: "Changes the description." }], closed: null };
      open("/chat", bridge({ "assist:open": { conversation: conversation([message({ id: "p1", kind: "decision", body: BODY, canApprove: true, approves: "changes", proposal: change })]) } }));

      const proposal = await screen.findByRole("region", { name: "Proposal" });
      expect(within(proposal).getByText("Changes the description.")).toBeInTheDocument();
      expect(within(proposal).getByRole("button", { name: "Apply change" })).toBeInTheDocument();
      fireEvent.click(within(proposal).getByRole("link", { name: "RPT-7" }));
      await waitFor(() => expect(window.location.hash).toBe("#/items/i1"));
    });
  });

  // EO-401: a corrected module proposed under the same slug replaces the
  // one nobody approved, and the catalog both cards draw holds the
  // corrected one. So the earlier card gives way to the newer.
  it("stops offering Approve on the earlier card for a replaced module, and offers it on the new one", async () => {
    const module = {
      id: "mod-1",
      slug: "release-merge",
      name: "Release merge",
      description: "Merges the release branch once CI is green.",
      code: "export default async () => ({ ok: true, result: 'merged' });",
      manifest: { name: "Release merge", description: "Merges.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["merged"] },
      originalScript: null,
      source: "architect" as const,
      approvedAt: null,
      createdAt: 1,
      updatedAt: 2,
      archivedAt: null,
      usedByStepCount: 0,
      portability: [],
      machineSpecific: [],
      testRun: null,
      testsStale: false,
      testCount: 1,
    };
    const earlier = message({ id: "c1", kind: "decision", body: "**New module** Release merge", moduleSlug: "release-merge", moduleReplaced: "below", createdAt: 1 });
    const newer = message({ id: "c2", kind: "decision", body: "**New module** Release merge", canApprove: true, approves: "module", moduleSlug: "release-merge", createdAt: 2 });
    open(
      "/chat",
      bridge({
        "assist:open": { conversation: conversation([earlier, newer]) },
        "modules:list": { modules: [module] },
        "moduleTests:list": { tests: [], problem: null },
      }),
    );

    await screen.findAllByText("Release merge");
    const [first, second] = screen.getAllByRole("region", { name: "Module proposal" });
    expect(within(first!).getByText(/A newer version of this module is below/)).toBeInTheDocument();
    expect(within(first!).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(within(second!).getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(within(second!).getByText("Not approved")).toBeInTheDocument();
  });

  // EO-581: a draft that needs modules nobody has approved lists them as
  // rows and offers one button, Approve and publish, which approves every
  // one and publishes the pipeline together — or none of it.
  describe("a drafted pipeline that needs modules", () => {
    const MODULE = {
      id: "mod-1",
      slug: "release-merge",
      name: "Release merge",
      description: "Merges the release branch once CI is green.",
      code: "export default async () => ({ ok: true, result: 'merged' });",
      manifest: { name: "Release merge", description: "Merges.", inputs: {}, needs: { bin: ["gh"], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["merged"] },
      originalScript: null,
      source: "architect",
      approvedAt: null as number | null,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null as number | null,
      usedByStepCount: 0,
      portability: [],
      machineSpecific: [],
      testRun: null,
      testsStale: false,
      testCount: 1,
    };
    const TAG = { ...MODULE, id: "mod-2", slug: "release-tag", name: "Release tag", description: "Tags the release." };
    const SENTENCE = 'Publish is waiting on "Release merge", which has not been approved. Approve it in Settings → Modules, then publish.';
    const waitingOn = (module: typeof MODULE, state = "unapproved") => ({ id: module.id, slug: module.slug, name: module.name, state });
    const passed = (module: typeof MODULE) => ({ id: module.id, slug: module.slug, name: module.name, outcome: "passed", problem: null, lineCoverage: 90 });

    type Pressed = (payload: { acknowledgeLowCoverage: string[] }, catalog: (typeof MODULE)[]) => Record<string, unknown>;

    /** Every module approved and the pipeline published: what the main process answers when every case passes. */
    const allPass =
      (pipelineId: string, created: boolean): Pressed =>
      (_payload, catalog) => {
        const modules = catalog.map(passed);
        for (const module of catalog) module.approvedAt = 5;
        return { saved: true, pipelineId, created, renamed: false, problem: null, modules, coverage: [] };
      };

    /** The main process, as far as this card can tell: a catalog, and a draft that waits on whatever in it is unapproved or deleted. */
    function room(target: { pipelineId: string | null; newPipelineName: string | null }, modules: (typeof MODULE)[], pressed?: Pressed, extra: Record<string, unknown> = {}) {
      const catalog = modules.map((module) => ({ ...module }));
      const draft = message({ id: "d1", body: "Here is the pipeline.", canApprove: true, approves: "pipeline" });
      const base = bridge({ "assist:open": { conversation: conversation([draft]) }, "moduleTests:list": { tests: [], problem: null }, ...extra });
      const invoke = vi.fn(async (channel: string, payload?: unknown) => {
        if (channel === "modules:list") return { ok: true, data: { modules: catalog.map((module) => ({ ...module })) } };
        if (channel === "assist:approveAndPublish") return { ok: true, data: pressed!(payload as { acknowledgeLowCoverage: string[] }, catalog) };
        if (channel === "assist:draft") {
          const waiting = catalog
            .filter((module) => module.archivedAt !== null || module.approvedAt === null)
            .map((module) => waitingOn(module, module.archivedAt !== null ? "gone" : "unapproved"));
          return {
            ok: true,
            data: { ...target, steps: STEPS, routes: ROUTES, entryStepId: "s-gather", problem: null, waiting, waitingProblem: waiting.length > 0 ? SENTENCE : null },
          };
        }
        return base(channel, payload);
      });
      return { invoke: open("/chat", invoke as never), catalog };
    }

    const pressedWith = (invoke: ReturnType<typeof vi.fn>) => invoke.mock.calls.filter(([channel]) => channel === "assist:approveAndPublish").map(([, payload]) => payload);

    it("keeps its picture, lists each module as a row with no Approve of its own, and offers one Approve and publish", async () => {
      room({ pipelineId: null, newPipelineName: "Release" }, [MODULE, TAG]);

      const card = await screen.findByRole("region", { name: "Pipeline draft" });
      expect(await within(card).findByText("Release")).toBeInTheDocument();
      expect(within(card).getByText("· 4 steps")).toBeInTheDocument();
      expect(within(within(card).getByRole("list", { name: "Pipeline graph" })).getByText("Gather")).toBeInTheDocument();

      const modules = within(await within(card).findByRole("list", { name: "Modules this draft needs" })).getAllByRole("listitem");
      expect(modules).toHaveLength(2);
      expect(await within(modules[0]!).findByText("Release merge")).toBeInTheDocument();
      expect(within(modules[0]!).getByText("Merges the release branch once CI is green.")).toBeInTheDocument();
      expect(within(modules[0]!).getByLabelText("What Release merge needs")).toHaveTextContent("Binariesgh");
      expect(within(modules[1]!).getByText("Release tag")).toBeInTheDocument();
      for (const row of modules) {
        expect(within(row).getByText("Not approved")).toBeInTheDocument();
        expect(within(row).getByRole("button", { name: "Show code" })).toBeInTheDocument();
        expect(within(row).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
      }

      expect(within(card).getAllByRole("button", { name: /Approve/ })).toHaveLength(1);
      expect(within(card).getByRole("button", { name: "Approve and publish" })).toBeEnabled();
      expect(within(card).queryByRole("button", { name: "Publish pipeline" })).not.toBeInTheDocument();
      // No error, and nobody is sent anywhere: the sentence is for a surface with no list.
      expect(card).not.toHaveTextContent("Settings → Modules");
      expect(card.querySelector(".text-danger")).toBeNull();
    });

    it("approves every module and creates the pipeline in one call, and reads Published", async () => {
      const { invoke } = room({ pipelineId: null, newPipelineName: "Release" }, [MODULE, TAG], allPass("p-release", true));

      const card = await screen.findByRole("region", { name: "Pipeline draft" });
      fireEvent.click(await within(card).findByRole("button", { name: "Approve and publish" }));

      await waitFor(() => expect(within(card).getByRole("button", { name: "Published" })).toBeDisabled());
      expect(pressedWith(invoke)).toEqual([{ conversationId: expect.any(String), messageId: "d1", acknowledgeLowCoverage: [] }]);
      // Not a module at a time, and not a second publish.
      expect(invoke.mock.calls.some(([channel]) => channel === "modules:approve")).toBe(false);
      expect(invoke.mock.calls.some(([channel]) => channel === "assist:publishNew")).toBe(false);
      expect(invoke.mock.calls.some(([channel]) => channel === "pipeline:save")).toBe(false);
      const rows = within(within(card).getByRole("list", { name: "Modules this draft needs" })).getAllByRole("listitem");
      for (const row of rows) expect(await within(row).findByText("Approved")).toBeInTheDocument();
    });

    it("approves its modules and publishes into the pipeline that exists in the same one call", async () => {
      const { invoke } = room({ pipelineId: "p-report", newPipelineName: null }, [MODULE], allPass("p-report", false));

      const card = await screen.findByRole("region", { name: "Pipeline draft" });
      fireEvent.click(await within(card).findByRole("button", { name: "Approve and publish" }));

      await waitFor(() => expect(within(card).getByRole("button", { name: "Published" })).toBeDisabled());
      expect(pressedWith(invoke)).toHaveLength(1);
      expect(invoke.mock.calls.some(([channel]) => channel === "pipeline:save")).toBe(false);
    });

    it("names the failing module and case, approves nothing and publishes nothing when a module's tests fail", async () => {
      const refusal = '"Release tag" was not approved: 1 of 1 test case failed.\n- tags v1: expected tagged';
      room({ pipelineId: null, newPipelineName: "Release" }, [MODULE, TAG], () => ({
        saved: false,
        pipelineId: null,
        created: false,
        renamed: false,
        problem: `Nothing was approved and nothing was published.\n${refusal}`,
        modules: [passed(MODULE), { id: TAG.id, slug: TAG.slug, name: TAG.name, outcome: "refused", problem: refusal, lineCoverage: 90 }],
        coverage: [],
      }));

      const card = await screen.findByRole("region", { name: "Pipeline draft" });
      fireEvent.click(await within(card).findByRole("button", { name: "Approve and publish" }));

      const rows = within(within(card).getByRole("list", { name: "Modules this draft needs" })).getAllByRole("listitem");
      const alert = await within(rows[1]!).findByRole("alert");
      expect(alert).toHaveTextContent("Release tag");
      expect(alert).toHaveTextContent("tags v1: expected tagged");
      expect(within(rows[0]!).queryByRole("alert")).not.toBeInTheDocument();
      expect(card).toHaveTextContent('Nothing was approved and nothing was published: "Release tag" was not approved.');
      for (const row of rows) expect(within(row).getByText("Not approved")).toBeInTheDocument();
      // Still a draft, and the button is there to press again once the module is fixed.
      expect(within(card).getByRole("button", { name: "Approve and publish" })).toBeEnabled();
      expect(within(card).queryByRole("button", { name: "Published" })).not.toBeInTheDocument();
    });

    it("asks for a coverage figure on the card before anything is approved, and approves and publishes once it is confirmed", async () => {
      const { invoke } = room({ pipelineId: null, newPipelineName: "Release" }, [MODULE, TAG], (payload, catalog) => {
        if (!payload.acknowledgeLowCoverage.includes(TAG.id)) {
          return {
            saved: false,
            pipelineId: null,
            created: false,
            renamed: false,
            problem: "under the bar",
            modules: [passed(MODULE), { id: TAG.id, slug: TAG.slug, name: TAG.name, outcome: "coverage", problem: "under the bar", lineCoverage: 62.5 }],
            coverage: [{ id: TAG.id, name: TAG.name, lineCoverage: 62.5 }],
          };
        }
        return allPass("p-release", true)(payload, catalog);
      });

      const card = await screen.findByRole("region", { name: "Pipeline draft" });
      fireEvent.click(await within(card).findByRole("button", { name: "Approve and publish" }));

      const asking = await within(card).findByRole("region", { name: "Coverage to confirm" });
      expect(asking).toHaveTextContent("Release tag");
      expect(asking).toHaveTextContent("62.5%");
      expect(asking).toHaveTextContent("Nothing has been approved or published yet.");
      // On the card itself, not in a window over it.
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "Approve and publish" })).toBeDisabled();

      fireEvent.click(within(asking).getByRole("button", { name: "Approve anyway and publish" }));

      await waitFor(() => expect(within(card).getByRole("button", { name: "Published" })).toBeDisabled());
      expect(pressedWith(invoke).map((payload) => (payload as { acknowledgeLowCoverage: string[] }).acknowledgeLowCoverage)).toEqual([[], [TAG.id]]);
      expect(within(card).queryByRole("region", { name: "Coverage to confirm" })).not.toBeInTheDocument();
    });

    it("writes nothing when the coverage question is cancelled, and says so", async () => {
      const { invoke } = room({ pipelineId: null, newPipelineName: "Release" }, [TAG], () => ({
        saved: false,
        pipelineId: null,
        created: false,
        renamed: false,
        problem: "under the bar",
        modules: [{ id: TAG.id, slug: TAG.slug, name: TAG.name, outcome: "coverage", problem: "under the bar", lineCoverage: 62.5 }],
        coverage: [{ id: TAG.id, name: TAG.name, lineCoverage: 62.5 }],
      }));

      const card = await screen.findByRole("region", { name: "Pipeline draft" });
      fireEvent.click(await within(card).findByRole("button", { name: "Approve and publish" }));
      fireEvent.click(within(await within(card).findByRole("region", { name: "Coverage to confirm" })).getByRole("button", { name: "Cancel" }));

      expect(await within(card).findByText(/Nothing was approved or published\. Line coverage of "Release tag" is 62\.5%/)).toBeInTheDocument();
      expect(pressedWith(invoke)).toHaveLength(1);
      expect(within(card).getByRole("button", { name: "Approve and publish" })).toBeEnabled();
    });

    it("shows a module deleted since as gone, and keeps the button disabled", async () => {
      room({ pipelineId: null, newPipelineName: "Release" }, [{ ...MODULE, archivedAt: 9 }]);

      const card = await screen.findByRole("region", { name: "Pipeline draft" });
      const row = (await within(card).findByRole("list", { name: "Modules this draft needs" })).querySelector("li")!;
      expect(await within(row).findByText("Deleted")).toBeInTheDocument();
      expect(within(row).getByText("Release merge")).toBeInTheDocument();
      expect(within(row).getByText(/Ask for the draft again\./)).toBeInTheDocument();
      expect(within(card).queryByRole("button", { name: "Approve and publish" })).not.toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "A module was deleted — can’t publish" })).toBeDisabled();
      expect(within(within(card).getByRole("list", { name: "Pipeline graph" })).getByText("Gather")).toBeInTheDocument();
    });
  });

  // EO-587: a draft the assistant planned a test for is a design card —
  // the graph, the modules it runs as rows, the test items with where
  // each must end and every step's mode — with Approve design and no
  // Publish.
  describe("a design card", () => {
    const MODULE = {
      id: "mod-1",
      slug: "release-merge",
      name: "Release merge",
      description: "Merges the release branch once CI is green.",
      code: "export default async () => ({ ok: true, result: 'merged' });",
      manifest: { name: "Release merge", description: "Merges.", inputs: {}, needs: { bin: ["gh"], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["merged"] },
      originalScript: null,
      source: "architect",
      approvedAt: null as number | null,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null as number | null,
      usedByStepCount: 0,
      portability: [],
      machineSpecific: [],
      testRun: null,
      testsStale: false,
      testCount: 1,
    };
    const TRIAL = {
      items: [
        { key: "weekly", title: "A normal week", body: null, expectedStepId: "s-filed", expectedStepName: "Filed", criteria: "the report has every team" },
        { key: "empty", title: "A week with nothing", body: "No team reported anything.", expectedStepId: "s-approve", expectedStepName: "Approve", criteria: null },
      ],
      steps: [
        { stepId: "s-gather", name: "Gather", mode: "real", reason: "It only reads the tracker.", reaches: null, mocks: [] },
        {
          stepId: "s-draft",
          name: "Draft",
          mode: "mocked",
          reason: "It posts to Slack, which reaches outside EO.",
          reaches: "sends",
          mocks: [
            { item: "A normal week", resultKey: "r3", output: "Drafted." },
            { item: "A week with nothing", resultKey: "r3", output: "" },
          ],
        },
        { stepId: "s-approve", name: "Approve", mode: "real", reason: null, reaches: null, mocks: [] },
        { stepId: "s-filed", name: "Filed", mode: "real", reason: null, reaches: null, mocks: [] },
      ],
      modules: [{ slug: "release-merge", name: "Release merge" }],
      changes: [] as string[],
      problem: null as string | null,
      approved: null as { trialPipelineId: string; round: number | null } | null,
    };

    function room(trial = TRIAL, approved = { approved: true, trialPipelineId: "t-1", round: 1, items: [], problem: null } as Record<string, unknown>) {
      let shown = trial;
      const draft = message({ id: "d1", body: "Here is the design.", canApprove: true, approves: "pipeline" });
      const base = bridge({ "assist:open": { conversation: conversation([draft]) }, "moduleTests:list": { tests: [], problem: null } });
      const invoke = vi.fn(async (channel: string, payload?: unknown) => {
        if (channel === "modules:list") return { ok: true, data: { modules: [MODULE] } };
        if (channel === "assist:draft") {
          return {
            ok: true,
            data: { pipelineId: null, newPipelineName: "Report", steps: STEPS, routes: ROUTES, entryStepId: "s-gather", problem: null, waiting: [], waitingProblem: null, trial: shown },
          };
        }
        if (channel === "assist:approveDesign") {
          if (approved["approved"] === true) shown = { ...trial, approved: { trialPipelineId: "t-1", round: 1 } };
          return { ok: true, data: approved };
        }
        return base(channel, payload);
      });
      return open("/chat", invoke as never);
    }

    it("shows the graph, the module rows, the test items with where each must end and every step's mode, with Approve design and no Publish", async () => {
      room();

      const card = await screen.findByRole("region", { name: "Pipeline draft" });
      expect(await within(card).findByText("design")).toBeInTheDocument();
      expect(within(within(card).getByRole("list", { name: "Pipeline graph" })).getByText("Gather")).toBeInTheDocument();

      const module = within(await within(card).findByRole("list", { name: "Modules this draft needs" })).getByRole("listitem");
      expect(await within(module).findByText("Release merge")).toBeInTheDocument();
      expect(within(module).getByLabelText("What Release merge needs")).toHaveTextContent("Binariesgh");
      expect(within(module).getByRole("button", { name: "Show code" })).toBeInTheDocument();

      const items = within(card).getByRole("region", { name: "Test items" });
      expect(items).toHaveTextContent("A normal week");
      expect(items).toHaveTextContent("Must end on Filed — the report has every team");
      expect(items).toHaveTextContent("A week with nothing");
      expect(items).toHaveTextContent("Must end on Approve");

      const modes = within(card).getByRole("region", { name: "How each step runs" });
      const rows = within(modes).getAllByRole("listitem").filter((row) => row.parentElement?.parentElement === modes);
      expect(rows.map((row) => row.textContent)).toEqual([
        // Each with the kind chip the graph above draws for it (EO-681), and none for where work ends.
        expect.stringContaining("GatheragentRuns for realIt only reads the tracker."),
        expect.stringContaining("DraftagentMockedSends outside EOIt posts to Slack, which reaches outside EO."),
        expect.stringContaining("ApprovepersonRuns for real"),
        expect.stringContaining("FiledRuns for real"),
      ]);
      expect(modes).toHaveTextContent("For “A normal week” it reports r3: Drafted.");

      expect(within(card).getByRole("button", { name: "Approve design" })).toBeEnabled();
      expect(within(card).queryByRole("button", { name: /Publish/ })).not.toBeInTheDocument();
      expect(within(card).queryByRole("button", { name: "Approve and publish" })).not.toBeInTheDocument();
      expect(card).toHaveTextContent("Nothing is published.");
    });

    it("approves the design in one call, and reads as under test with nothing left to press", async () => {
      const invoke = room();

      const card = await screen.findByRole("region", { name: "Pipeline draft" });
      fireEvent.click(await within(card).findByRole("button", { name: "Approve design" }));

      await waitFor(() => expect(within(card).getByRole("button", { name: "Design approved" })).toBeDisabled());
      expect(invoke.mock.calls.filter(([channel]) => channel === "assist:approveDesign").map(([, payload]) => payload)).toEqual([{ conversationId: expect.any(String), messageId: "d1" }]);
      expect(invoke.mock.calls.some(([channel]) => channel === "pipeline:save" || channel === "assist:publishNew" || channel === "assist:approveAndPublish")).toBe(false);
      expect(card).toHaveTextContent("Testing with real runs — round 1");
    });

    it("says what refused it, and keeps the button", async () => {
      room(TRIAL, { approved: false, trialPipelineId: null, round: null, items: [], problem: "Nothing was made to test: a trial's test items work on one of the project's workspaces, and it has none attached." });

      const card = await screen.findByRole("region", { name: "Pipeline draft" });
      fireEvent.click(await within(card).findByRole("button", { name: "Approve design" }));

      expect(await within(card).findByText(/it has none attached/)).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "Approve design" })).toBeEnabled();
    });

    it("says what a design posted mid-test changes, and holds the button while its plan does not fit", async () => {
      room({ ...TRIAL, changes: ['it adds the step "Review"'], problem: "The trial plan does not fit this draft, so this design cannot be approved." });

      const card = await screen.findByRole("region", { name: "Pipeline draft" });
      const changes = await within(card).findByRole("region", { name: "What this design changes" });
      expect(changes).toHaveTextContent('it adds the step "Review"');
      expect(within(card).getByText(/does not fit this draft/)).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "Approve design" })).toBeDisabled();
    });
  });

  it("lists every pipeline with what it holds, whoever made it", async () => {
    open("/chat");

    const report = await within(await screen.findByRole("navigation", { name: "Main" })).findByRole("link", { name: /Weekly report/ });
    expect(within(report).getByText("1 needs attention")).toBeInTheDocument();
    expect(within(within(rail()).getByRole("link", { name: /Vendor invoices/ })).getByText("2 planned, 0 finished")).toBeInTheDocument();
  });

  /**
   * EO-384. The step names are the wrong way round on purpose: the one
   * item on a terminal step stands on "In progress" and the two that are
   * not stand on "Done", so a count read off a name comes out 1/2.
   */
  it("counts a pipeline's planned and finished items by what the main process said, not by a step's name", async () => {
    open(
      "/chat",
      bridge({
        "items:list": {
          items: [
            item({ id: "a", pipelineId: "p-invoices", stepName: "Done", latestRunStatus: "running" }),
            item({ id: "b", pipelineId: "p-invoices", stepName: "Done" }),
            item({ id: "c", pipelineId: "p-invoices", stepName: "In progress", atTerminalStep: true }),
            // A feature is on no pipeline, and is in neither number.
            item({ id: "f", pipelineId: null, stepId: null, container: true, stepName: "Done", atTerminalStep: true }),
          ],
        },
      }),
    );

    const invoices = await within(await screen.findByRole("navigation", { name: "Main" })).findByRole("link", { name: /Vendor invoices/ });
    expect(await within(invoices).findByText("2 planned, 1 finished")).toBeInTheDocument();
    // What a sighted reader gets: both numbers, the finished one in the success colour.
    const drawn = within(invoices).getByText("1");
    expect(drawn).toHaveClass("text-success");
    expect(drawn.parentElement).toHaveTextContent("2/1");
    expect(drawn.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(drawn.parentElement?.parentElement).toHaveClass("text-ink-subtle");

    // A pipeline holding nothing says nothing.
    const report = within(rail()).getByRole("link", { name: /Weekly report/ });
    expect(report).toHaveTextContent(/^Weekly report$/);
  });

  it("gives way to the waiting badge on a pipeline with an item needing attention", async () => {
    open(
      "/chat",
      bridge({
        "items:list": {
          items: [item({ id: "a", needsAttention: true }), item({ id: "b" }), item({ id: "c", stepId: "s-filed", stepName: "Filed", atTerminalStep: true })],
        },
      }),
    );

    const report = await within(await screen.findByRole("navigation", { name: "Main" })).findByRole("link", { name: /Weekly report/ });
    expect(await within(report).findByText("1 needs attention")).toBeInTheDocument();
    expect(within(report).queryByText(/planned/)).not.toBeInTheDocument();
  });

  it("moves an item from planned to finished, and out of both, without a reload", async () => {
    const listeners: ((payload: unknown) => void)[] = [];
    const subscribe = window.eo.ipc.subscribe;
    window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: unknown) => void) => {
      if (channel === "items:changed") listeners.push(callback);
      return () => {};
    }) as never;
    const changed = () => act(() => listeners.forEach((listener) => listener({})));

    try {
      let held = [item({ id: "a" }), item({ id: "b" })];
      const invoke = bridge();
      open(
        "/chat",
        vi.fn(async (channel: string, payload?: unknown) => (channel === "items:list" ? { ok: true, data: { items: held } } : invoke(channel, payload))) as never,
      );

      const report = await within(await screen.findByRole("navigation", { name: "Main" })).findByRole("link", { name: /Weekly report/ });
      expect(await within(report).findByText("2 planned, 0 finished")).toBeInTheDocument();

      // One reaches the terminal step.
      held = [item({ id: "a" }), item({ id: "b", stepId: "s-filed", stepName: "Filed", atTerminalStep: true })];
      changed();
      expect(await within(report).findByText("1 planned, 1 finished")).toBeInTheDocument();

      // And is archived, which takes it off the list.
      held = [item({ id: "a" })];
      changed();
      expect(await within(report).findByText("1 planned, 0 finished")).toBeInTheDocument();
    } finally {
      window.eo.ipc.subscribe = subscribe;
    }
  });

  it("finds an item from the rail's search and opens it beside the conversation", async () => {
    open("/chat");

    await screen.findByRole("navigation", { name: "Main" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(await screen.findByRole("textbox", { name: "Search items and pipelines" }), { target: { value: "fabrikam" } });
    fireEvent.click(await screen.findByRole("button", { name: /Fabrikam office lease/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/items/i3"));
  });

  // What Chromium reports as the platform on each system EO ships for.
  // jsdom reports none, so without this every run here is "not a Mac"
  // whatever machine it is on, and the Mac branch is never taken.
  it.each([
    { system: "a Mac", platform: "MacIntel", label: "⌘K", keys: { metaKey: true } },
    { system: "Windows", platform: "Win32", label: "Ctrl+K", keys: { ctrlKey: true } },
    { system: "Linux", platform: "Linux x86_64", label: "Ctrl+K", keys: { ctrlKey: true } },
  ])("on $system, labels the search $label and opens it on that key", async ({ platform, label, keys }) => {
    const reported = vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
    try {
      open("/chat");

      const search = within(await screen.findByRole("navigation", { name: "Main" })).getByRole("button", { name: /^Search/ });
      expect(search).toHaveTextContent(`Search${label}`);

      fireEvent.keyDown(window, { key: "k", ...keys });
      expect(await screen.findByRole("textbox", { name: "Search items and pipelines" })).toBeInTheDocument();
    } finally {
      reported.mockRestore();
    }
  });

  it("gives way to the conversation rather than offering a second door into it", async () => {
    open("/chat");
    await screen.findByRole("region", { name: "Conversation" });
    expect(screen.queryByRole("button", { name: "Ask the assistant" })).not.toBeInTheDocument();
  });
});

describe("the canvas", () => {
  it("opens a board beside the conversation, with each step's owner and the items on it", async () => {
    open("/pipelines/p-report");

    const canvas = await screen.findByRole("region", { name: "Canvas" });
    const approve = await within(canvas).findByRole("region", { name: /^Approve/ });
    expect(within(approve).getByText("you")).toBeInTheDocument();
    expect(await within(approve).findByText("Week of 29 September")).toBeInTheDocument();
    expect(within(within(canvas).getByRole("region", { name: /^Gather/ })).getByText("reporter")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Conversation" })).toBeInTheDocument();
  });

  it("keeps a tab for each view opened, and closes back to the conversation alone", async () => {
    open("/pipelines/p-report");

    const canvas = await screen.findByRole("region", { name: "Canvas" });
    fireEvent.click(await within(canvas).findByRole("link", { name: "RPT-7" }));
    await waitFor(() => expect(window.location.hash).toBe("#/items/i1"));

    const tabs = within(canvas).getByRole("tablist", { name: "Open views" });
    expect(await within(tabs).findByRole("tab", { name: /RPT-7/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(tabs).getByRole("tab", { name: /Weekly report/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/pipelines/p-report"));

    fireEvent.click(screen.getByRole("button", { name: "Close the canvas" }));
    await waitFor(() => expect(window.location.hash).toBe("#/chat"));
    expect(screen.queryByRole("region", { name: "Canvas" })).not.toBeInTheDocument();
  });

  it("draws a pipeline's graph: steps in order as boxes, and every route as an arrow with its result on it", async () => {
    open("/pipelines/p-report?view=graph");

    const canvas = await screen.findByRole("region", { name: "Canvas" });
    const graph = await within(canvas).findByRole("list", { name: "Pipeline graph" });
    expect(within(graph).getAllByTitle("agent · reporter").map((chip) => chip.textContent)).toEqual(["agent", "agent"]);
    // The published pipeline is never drawn as anybody's draft (EO-680).
    expect(graph.querySelectorAll("[data-new-step]")).toHaveLength(0);
    expect(within(graph).queryByText("new")).not.toBeInTheDocument();
    const routes = within(canvas).getByRole("list", { name: "Routes" });
    expect(within(routes).getByText("Gathered")).toBeInTheDocument();
    expect(within(routes).getAllByRole("listitem").map(routeLine)).toEqual(
      expect.arrayContaining(["Send back: Approve → Draft", "Nothing to report: Gather → you"]),
    );
  });

  it("opens a pipeline's Changes view at its own address, in the pipeline's tab, with the way to the conversation (EO-524)", async () => {
    const invoke = open(
      "/pipelines/p-report/changes?from=1&to=2",
      bridge({
        "pipeline:versions": {
          versions: [
            { id: "v1", pipelineId: "p-report", number: 1, createdAt: 1, createdBy: null, createdByName: null },
            { id: "v2", pipelineId: "p-report", number: 2, createdAt: 2, createdBy: "p1", createdByName: "Dana" },
          ],
          current: 2,
          graph: null,
          diff: { from: 1, to: 2, steps: [{ stepId: "s-qa", name: "QA", change: "added", fields: [] }], routes: [] },
          local: null,
        },
      }),
    );

    const canvas = await screen.findByRole("region", { name: "Canvas" });
    expect(await within(canvas).findByText("added")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("pipeline:versions", { pipelineId: "p-report", from: 1, to: 2 });
    expect(within(canvas).queryByRole("button", { name: /publish|restore|discard/i })).toBeNull();
    expect(within(canvas).getByRole("button", { name: "Ask the assistant" })).toBeInTheDocument();
  });

  it("draws a draft and the Graph view of the same steps and routes as the same boxes and arrows", async () => {
    const draft = message({ id: "d1", body: "Here is the pipeline.", canApprove: true, approves: "pipeline" });
    open(
      "/pipelines/p-report?view=graph",
      bridge({
        "assist:open": { conversation: conversation([draft]) },
        "assist:draft": { pipelineId: "p-report", steps: STEPS, routes: ROUTES, entryStepId: "s-gather", problem: null },
      }),
    );

    /** Where everything was put: each box, each line and arrowhead, each label and marker. */
    const drawn = (within_: HTMLElement) => {
      const sheet = within(within_).getByRole("list", { name: "Pipeline graph" }).parentElement!;
      return {
        sheet: sheet.getAttribute("style"),
        boxes: [...sheet.querySelectorAll("[data-step]")].map((box) => [box.getAttribute("data-step"), box.getAttribute("style"), box.querySelector("[title]")?.textContent]),
        arrows: [...sheet.querySelectorAll("[data-route]")].map((arrow) => [arrow.getAttribute("data-route"), ...[...arrow.querySelectorAll("path")].map((path) => path.getAttribute("d"))]),
        texts: [...sheet.querySelectorAll("ul span[style]")].map((text) => [text.textContent, text.getAttribute("style")]),
      };
    };

    const card = await screen.findByRole("region", { name: "Pipeline draft" });
    await within(card).findByRole("list", { name: "Pipeline graph" });
    const canvas = screen.getByRole("region", { name: "Canvas" });
    await within(canvas).findByRole("list", { name: "Pipeline graph" });
    await waitFor(() => expect(drawn(card)).toEqual(drawn(canvas)));
    expect(drawn(card).boxes).toHaveLength(4);
    expect(drawn(card).arrows).toHaveLength(5);
  });

  it("draws an item from its type, without printing its criteria twice, and decides on it there", async () => {
    const invoke = open("/items/i1", bridge({ "items:decide": { decided: true, problem: null } }));

    const card = await screen.findByRole("article", { name: "Week of 29 September" });
    expect(within(card).getByText("Period")).toBeInTheDocument();
    expect(within(card).getByText("Leadership")).toBeInTheDocument();
    expect(within(card).queryByText("Must cover")).not.toBeInTheDocument();
    expect(within(card).getByRole("list", { name: "Acceptance criteria" })).toHaveTextContent("What slipped and why");

    // A result that needs a reason asks for it before deciding.
    fireEvent.click(within(card).getByRole("button", { name: "Send back → Draft" }));
    fireEvent.change(within(card).getByRole("textbox", { name: "Why Send back" }), { target: { value: "The Q3 number is wrong" } });
    fireEvent.click(within(card).getAllByRole("button", { name: "Send back → Draft" })[1]!);
    await waitFor(() =>
      expect(
        invoke.mock.calls.some(([channel, input]) => channel === "items:decide" && (input as { comment: string }).comment === "The Q3 number is wrong"),
      ).toBe(true),
    );
  });

  it("never carries a half-written reason from one item to the next", async () => {
    open("/items/i3");
    // Visited first, so it is in the cache when it comes back: a cached
    // item draws at once, which is when a reused view would keep its state.
    await screen.findByRole("tab", { name: /INV-11/ });

    window.location.hash = "#/items/i1";
    const first = await screen.findByRole("article", { name: "Week of 29 September" });
    fireEvent.click(within(first).getByRole("button", { name: "Send back → Draft" }));
    fireEvent.change(within(first).getByRole("textbox", { name: "Why Send back" }), { target: { value: "Meant for RPT-7 only" } });

    fireEvent.click(screen.getByRole("tab", { name: /INV-11/ }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /INV-11/ })).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByRole("textbox", { name: "Why Send back" })).not.toBeInTheDocument();
  });

  it("keeps a pipeline's board and graph in one tab", async () => {
    open("/pipelines/p-report");

    const canvas = await screen.findByRole("region", { name: "Canvas" });
    const views = await within(canvas).findByRole("navigation", { name: "Pipeline views" });
    fireEvent.click(within(views).getByRole("link", { name: "Graph" }));
    await waitFor(() => expect(window.location.hash).toBe("#/pipelines/p-report?view=graph"));
    expect(within(canvas).getAllByRole("tab")).toHaveLength(1);
  });
});

describe("every place in the chat layout", () => {
  it.each([
    "/settings",
    "/agents",
    "/agent-tools",
    "/jobs",
    "/inbox",
    "/items",
    "/archive",
    "/mentions",
    "/gallery",
    "/pipelines/p-report",
    "/pipelines/p-report/configure",
    "/items/i1",
    "/items/i1/runs",
  ])("draws %s as a view of its own, with none of the classic screen's chrome", async (path) => {
    open(path);

    await screen.findByRole("region", { name: "Canvas" });
    expect(screen.getAllByRole("navigation", { name: "Main" })).toHaveLength(1);
    for (const classic of ["Go back", "Go forward", "Hide the sidebar", "Show the sidebar"]) {
      expect(screen.queryByRole("button", { name: classic })).not.toBeInTheDocument();
    }
    // Nor the classic top bar's search box, which said "Open a pipeline to filter" everywhere else.
    expect(screen.queryByRole("textbox", { name: "Search" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Open a pipeline to filter")).not.toBeInTheDocument();
  });

  it("sends an address nothing draws to the conversation", async () => {
    open("/nowhere");
    await waitFor(() => expect(window.location.hash).toBe("#/chat"));
    expect(await screen.findByRole("textbox", { name: "Message the assistant" })).toBeInTheDocument();
  });

  it("has one room: Discussions' addresses come to the conversation, and no menu offers them", async () => {
    open("/discussions/c1");
    await waitFor(() => expect(window.location.hash).toBe("#/chat"));
    expect(await screen.findByRole("textbox", { name: "Message the assistant" })).toBeInTheDocument();

    fireEvent.click(within(rail()).getByRole("button", { name: "More places" }));
    expect(screen.getByRole("menuitem", { name: "Agents" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Discussions" })).not.toBeInTheDocument();
  });

  it("opens a pipeline's old configure address on its Graph view, with no editor anywhere (EO-525)", async () => {
    open("/pipelines/p-report/configure");

    // Replaced by the graph's own address, which is what the assistant reads.
    await waitFor(() => expect(window.location.hash).toBe("#/pipelines/p-report?view=graph"));
    const canvas = await screen.findByRole("region", { name: "Canvas" });
    const views = await within(canvas).findByRole("navigation", { name: "Pipeline views" });
    expect(within(views).getByRole("link", { name: "Graph" })).toHaveAttribute("aria-current", "page");
    expect(within(canvas).getAllByRole("tab")).toHaveLength(1);
    // Board and Graph, and no third way in.
    expect(within(views).getAllByRole("link").map((link) => link.textContent)).toEqual(["Board", "Graph"]);
    expect(within(canvas).queryByRole("link", { name: /configure/i })).not.toBeInTheDocument();
    expect(within(canvas).queryByRole("button", { name: /publish/i })).not.toBeInTheDocument();
    // A view beside the conversation, as the graph always is — not one drawn for the width.
    expect(screen.getByRole("region", { name: "Conversation" })).toBeInTheDocument();
  });

  it("hands New pipeline to the conversation with the cursor in its box, and creates nothing (EO-525)", async () => {
    const invoke = open("/settings");

    await screen.findByRole("region", { name: "Canvas" });
    // Settings is drawn for the width, so the conversation starts folded to its strip.
    expect(screen.queryByRole("region", { name: "Conversation" })).not.toBeInTheDocument();
    // Waited for: the composer is drawn once the room has opened, which is not when the canvas is.
    await screen.findByRole("textbox", { name: "Message the assistant", hidden: true });

    fireEvent.click(within(rail()).getByRole("button", { name: "New pipeline" }));
    const box = await within(await screen.findByRole("region", { name: "Conversation" })).findByRole("textbox", { name: "Message the assistant" });
    await waitFor(() => expect(box).toHaveFocus());
    expect(invoke.mock.calls.some(([channel]) => channel === "pipelines:create")).toBe(false);
    expect(window.location.hash).toBe("#/settings");
  });

  it("keeps New pipeline's cursor for the box when the room is still opening as it is pressed (EO-525)", async () => {
    let openRoom = () => {};
    const roomOpened = new Promise<void>((resolve) => {
      openRoom = resolve;
    });
    const base = bridge();
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "assist:open") await roomOpened;
      return base(channel, payload);
    });
    open("/settings", invoke);

    await screen.findByRole("region", { name: "Canvas" });
    fireEvent.click(within(rail()).getByRole("button", { name: "New pipeline" }));
    const column = await screen.findByRole("region", { name: "Conversation" });

    openRoom();
    const box = await within(column).findByRole("textbox", { name: "Message the assistant" });
    await waitFor(() => expect(box).toHaveFocus());
    expect(invoke.mock.calls.some(([channel]) => channel === "pipelines:create")).toBe(false);
  });

  it("keeps what was typed when an old configure address is replaced by the graph's (EO-525)", async () => {
    open("/pipelines/p-report");
    const column = await screen.findByRole("region", { name: "Conversation" });
    const box = await within(column).findByRole("textbox", { name: "Message the assistant" });
    fireEvent.change(box, { target: { value: "Half a thought" } });

    window.location.hash = "#/pipelines/p-report/configure";
    await waitFor(() => expect(window.location.hash).toBe("#/pipelines/p-report?view=graph"));
    await screen.findByRole("navigation", { name: "Pipeline views" });
    // The same box, never remade: the frame stayed drawn while the address moved.
    expect(screen.getByRole("textbox", { name: "Message the assistant" })).toBe(box);
    expect(box).toHaveValue("Half a thought");
  });

  it("hands an empty board to the conversation beside it, keeping what was typed", async () => {
    open("/pipelines/p-report", bridge({ "pipelineSteps:list": { steps: [], routes: [], entryStepId: null } }));
    await screen.findByRole("region", { name: "Canvas" });
    const column = screen.getByRole("region", { name: "Conversation" });
    // Waited for: the composer is drawn once the room has opened, which is not when the canvas is.
    const box = await within(column).findByRole("textbox", { name: "Message the assistant" });
    fireEvent.change(box, { target: { value: "Half a thought" } });
    fireEvent.click(within(column).getByRole("button", { name: "Fold the conversation" }));

    // The board's head no longer plans (EO-518); an empty board points to the assistant instead.
    expect(screen.queryByRole("button", { name: "Plan in chat" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Ask the assistant" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message the assistant" })).toHaveFocus());
    expect(screen.getByRole("textbox", { name: "Message the assistant" })).toHaveValue("Half a thought");
    expect(window.location.hash).toBe("#/pipelines/p-report");
  });
});

describe("the canvas's tabs", () => {
  it("draws a view afresh for another item, and keeps one view whose address moves under it", async () => {
    const mount = (path: string, search = "") => mountKeyOf(chatViewFor(path, search)!);
    // One mount, holding what it holds: a Settings section or a board
    // narrowed to a step is not thrown away with a remount.
    expect(mount("/settings", "?section=layout")).toBe(mount("/settings", "?section=projects"));
    expect(mount("/pipelines/p1")).toBe(mount("/pipelines/p1", "?step=s1"));
    // Two mounts: another item, or another way of seeing the same one.
    expect(mount("/items/i1")).not.toBe(mount("/items/i3"));
    expect(mount("/items/i1")).not.toBe(mount("/items/i1/runs"));
    expect(mount("/pipelines/p1")).not.toBe(mount("/pipelines/p1", "?view=graph"));

    open("/items/i1");
    const item = await screen.findByRole("article", { name: "Week of 29 September" });
    window.location.hash = "#/items/i3";
    const selected = () => within(screen.getByRole("tablist", { name: "Open views" })).getByRole("tab", { selected: true });
    await waitFor(() => expect(selected()).toHaveTextContent("INV-11"));
    expect(item).not.toBeInTheDocument();
  });

  it("closes one tab, moving to the one before it when it was open, and to the conversation after the last", async () => {
    open("/pipelines/p-report");
    await screen.findByRole("region", { name: "Canvas" });
    const row = () => screen.getByRole("tablist", { name: "Open views" });
    const openTabs = () => within(row()).getAllByRole("tab");
    window.location.hash = "#/inbox";
    await waitFor(() => expect(openTabs()).toHaveLength(2));

    // The pointer's close sits beside the tab, out of the tablist's reading
    // order: only tabs belong in a tablist.
    const closeButton = (tab: HTMLElement) => tab.parentElement!.querySelector<HTMLElement>('button[title="Close this tab"]')!;
    expect(closeButton(openTabs()[0]!)).toHaveAttribute("aria-hidden", "true");
    expect(within(row()).queryAllByRole("button")).toHaveLength(0);

    fireEvent.click(closeButton(within(row()).getByRole("tab", { name: /Inbox/ })));
    await waitFor(() => expect(window.location.hash).toBe("#/pipelines/p-report"));
    // Waited for, as the count is on the way in above: the address
    // changes a render before the row does, and on a loaded machine an
    // assertion made between the two still sees the closed tab (EO-396's
    // CI run failed here, on a branch that touches no renderer file).
    await waitFor(() => expect(openTabs()).toHaveLength(1));

    // The keyboard's: Delete on the focused tab.
    fireEvent.keyDown(within(row()).getByRole("tab", { name: /Weekly report/ }), { key: "Delete" });
    await waitFor(() => expect(window.location.hash).toBe("#/chat"));
    expect(screen.queryByRole("region", { name: "Canvas" })).not.toBeInTheDocument();
  });

  /**
   * The race the test above lost on loaded CI machines, made certain.
   *
   * The row draws the open view's tab a render before the effect that
   * records it has run. Clicking its close in that gap used to remove it,
   * and then the recording, queued before the click, put it straight
   * back: two tabs for good, however long anything waited. Waiting on
   * the DOM with a MutationObserver — outside `act`, so nothing flushes
   * the effect first — clicks in exactly that gap every time.
   */
  it("keeps a tab closed that was closed before it had been recorded", async () => {
    open("/pipelines/p-report");
    await screen.findByRole("region", { name: "Canvas" });
    const row = () => screen.getByRole("tablist", { name: "Open views" });
    const openTabs = () => within(row()).getAllByRole("tab");
    window.location.hash = "#/inbox";
    await new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (openTabs().length === 2) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const closeButton = (tab: HTMLElement) => tab.parentElement!.querySelector<HTMLElement>('button[title="Close this tab"]')!;
    fireEvent.click(closeButton(within(row()).getByRole("tab", { name: /Inbox/ })));
    await waitFor(() => expect(window.location.hash).toBe("#/pipelines/p-report"));
    await waitFor(() => expect(openTabs()).toHaveLength(1));
    // And it was closed, not forgotten: opening it again opens it again.
    window.location.hash = "#/inbox";
    await waitFor(() => expect(openTabs()).toHaveLength(2));
  });

  it("keeps the newest eight, dropping the one opened first", async () => {
    const paths = ["/pipelines/p-report", "/inbox", "/items", "/mentions", "/archive", "/agents", "/settings", "/gallery", "/jobs"];
    open(paths[0]!);
    await screen.findByRole("region", { name: "Canvas" });
    const openTabs = () => within(screen.getByRole("tablist", { name: "Open views" })).getAllByRole("tab");
    for (const [index, path] of paths.entries()) {
      if (index === 0) continue;
      window.location.hash = `#${path}`;
      await waitFor(() => expect(openTabs()).toHaveLength(Math.min(index + 1, 8)));
    }
    await waitFor(() => expect(openTabs().some((tab) => /Weekly report/.test(tab.textContent ?? ""))).toBe(false));
    expect(openTabs()).toHaveLength(8);
    expect(openTabs().at(-1)).toHaveAttribute("aria-selected", "true");
  });

  it("starts the row afresh when the project changes, keeping only the view open now", async () => {
    let active = "a";
    const projects = () => ({
      projects: [
        { id: "a", name: "Finance", keyPrefix: "FIN", repositoryIds: [], itemCount: 0, costCents: 0 },
        { id: "b", name: "Operations", keyPrefix: "OPS", repositoryIds: [], itemCount: 0, costCents: 0 },
      ],
      activeProjectId: active,
    });
    const base = bridge();
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "projects:list") return { ok: true, data: projects() };
      if (channel === "projects:setActive") {
        active = (payload as { id: string }).id;
        return { ok: true, data: {} };
      }
      return base(channel, payload);
    });
    open("/pipelines/p-report", invoke);
    const openTabs = () => within(screen.getByRole("tablist", { name: "Open views" })).getAllByRole("tab");
    await screen.findByRole("region", { name: "Canvas" });
    window.location.hash = "#/inbox";
    await waitFor(() => expect(openTabs()).toHaveLength(2));

    fireEvent.click(await within(rail()).findByRole("button", { name: "Switch project" }));
    fireEvent.click(await screen.findByRole("button", { name: "Operations" }));
    await waitFor(() => expect(openTabs()).toHaveLength(1));
    expect(openTabs()[0]).toHaveTextContent("Inbox");
  });
});

/**
 * EO-408: a row of a new-work proposal opens that item beside the
 * conversation, drawn as the item it will be and marked as not filed.
 *
 * One bridge stands in for the main process across the whole act: it
 * answers the card (`assist:open`) and the view (`assist:proposal`) from
 * one state, and `assist:approve` moves that state — so what a case sees
 * after a press is what both would be re-read as, not two fixtures that
 * happen to agree.
 */
describe("a proposed item, open in the canvas", () => {
  const CONVERSATION_ID = conversation().id;
  const CREATED = [
    { itemId: "i1", key: "RPT-7" },
    { itemId: "i2", key: "INV-14" },
    { itemId: "i3", key: "INV-11" },
  ];
  const ROWS = [
    { title: "What shipped", description: "DESCRIPTION of what shipped, at length.", acceptanceCriteria: ["Every release is named", "It cites its source"], waitsOn: [] },
    {
      title: "What slipped",
      description: "DESCRIPTION of what slipped.\n\nWith a second paragraph.",
      acceptanceCriteria: ["Every slip has a reason", "It cites its source", "Nothing is blamed on a person"],
      waitsOn: [{ key: null, title: "What shipped" }],
    },
    { title: "What is next", description: "", acceptanceCriteria: [], waitsOn: [{ key: "RPT-3", title: "The roadmap" }] },
  ];

  /** The main process, as far as a proposal goes. `state` is what a press changes. */
  function proposing(start: "open" | "applied" | "superseded" = "open", overrides: Record<string, unknown> = {}) {
    const state = { now: start };
    const rows = (full: boolean) =>
      ROWS.map(({ description, ...row }, index) => ({
        kind: "new",
        typeLabel: "Section",
        under: null,
        ...row,
        ...(full ? { description } : {}),
        created: state.now === "applied" ? CREATED[index] : null,
      }));
    const closed = () => (state.now === "open" ? null : state.now);
    const thread = () =>
      conversation([
        message({ id: "n1", body: "Here is the review as three sections." }),
        message({
          id: "p1",
          kind: "decision",
          body: "PROSE that is never drawn.",
          createdAt: 2,
          canApprove: state.now === "open",
          approves: state.now === "open" ? "items" : null,
          proposal: { container: { title: "Quarterly review", typeLabel: "Report" }, rows: rows(false), closed: closed() },
        }),
      ]);
    const base = bridge(overrides);
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel in overrides) return base(channel, payload);
      if (channel === "assist:open") return { ok: true, data: { conversation: thread() } };
      if (channel === "assist:proposal") {
        const known = (payload as { messageId: string }).messageId === "p1";
        return {
          ok: true,
          data: {
            proposal: known
              ? {
                  conversationId: CONVERSATION_ID,
                  canApprove: state.now === "open",
                  container: { title: "Quarterly review", typeLabel: "Report" },
                  rows: rows(true),
                  closed: closed(),
                  landsOn: { pipelineName: "Weekly report", stepName: "Gather" },
                }
              : null,
          },
        };
      }
      if (channel === "assist:approve") {
        // Once, whoever presses: the second press is told it was already applied.
        const applied = state.now === "open";
        if (applied) state.now = "applied";
        return {
          ok: true,
          data: {
            applied,
            problem: applied ? null : "That proposal has been superseded or already applied. Read the newest one and approve that instead.",
            createdKeys: applied ? ["RPT-6", ...CREATED.map((item) => item.key)] : [],
            changedKeys: [],
            conversation: thread(),
          },
        };
      }
      return base(channel, payload);
    });
    return { invoke: invoke as unknown as ReturnType<typeof bridge>, state };
  }

  const sent = (invoke: ReturnType<typeof bridge>, channel: string) => invoke.mock.calls.filter(([name]) => name === channel).map(([, payload]) => payload);
  const canvas = () => screen.findByRole("region", { name: "Canvas" });
  const card = () => screen.findByRole("region", { name: "Proposal" });
  const openTabs = () => within(screen.getByRole("tablist", { name: "Open views" })).getAllByRole("tab");

  it("opens from a row of the card, as the item it will be and marked as not filed", async () => {
    const { invoke } = proposing();
    open("/chat", invoke);

    fireEvent.click(within(await card()).getByRole("link", { name: /^What slipped/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/proposals/p1/1"));

    const view = within(await canvas());
    const item = await view.findByRole("article", { name: "What slipped" });
    expect(view.getByRole("heading", { name: "What slipped" })).toBeInTheDocument();
    // Its type's label, and the mark where a key would be.
    expect(view.getByText("Section")).toBeInTheDocument();
    expect(view.getAllByText("Not filed yet").length).toBeGreaterThan(0);
    expect(await canvas()).not.toHaveTextContent(/RPT-\d|INV-\d/);
    // The description and every criterion, at full length.
    expect(within(item).getByText("DESCRIPTION of what slipped.")).toBeInTheDocument();
    expect(within(item).getByText("With a second paragraph.")).toBeInTheDocument();
    expect(within(within(item).getByRole("list", { name: "Acceptance criteria" })).getAllByRole("listitem").map((entry) => entry.textContent)).toEqual([
      "Every slip has a reason",
      "It cites its source",
      "Nothing is blamed on a person",
    ]);
    // What it waits on, by title, and where it will land.
    expect(within(within(item).getByRole("region", { name: "Dependencies" })).getByText("What shipped")).toBeInTheDocument();
    const about = within(view.getByRole("complementary", { name: "About" }));
    expect(about.getByText("Weekly report")).toBeInTheDocument();
    expect(about.getByText("Gather")).toBeInTheDocument();
    expect(about.getByText("Quarterly review · Report")).toBeInTheDocument();

    // Nothing an item has only once it exists.
    expect(view.queryByRole("region", { name: "Timeline" })).not.toBeInTheDocument();
    expect(view.queryByText("Thread")).not.toBeInTheDocument();
    expect(view.queryByRole("tablist", { name: "Item or runs" })).not.toBeInTheDocument();
    expect(view.queryByRole("textbox")).not.toBeInTheDocument();
    expect(view.queryByRole("combobox")).not.toBeInTheDocument();
    expect(view.queryByRole("button", { name: /Delete|Archive|Assign|Move/ })).not.toBeInTheDocument();
    expect(view.queryByRole("list", { name: /steps/i })).not.toBeInTheDocument();

    // Its own tab, named for it, and the assistant told which address is open.
    expect(openTabs().map((tab) => tab.textContent)).toEqual(["What slipped"]);
    await waitFor(() => expect(sent(invoke, "view:publish").at(-1)).toMatchObject({ page: { route: "/proposals/:messageId/:index", params: { messageId: "p1", index: "1" } } }));
    // Read from the proposal, by the card's message.
    expect(sent(invoke, "assist:proposal")).toContainEqual({ messageId: "p1" });

    // Another row is another tab.
    fireEvent.click(within(await card()).getByRole("link", { name: /^What is next/ }));
    await waitFor(() => expect(openTabs().map((tab) => tab.textContent)).toEqual(["What slipped", "What is next"]));
    const next = await view.findByRole("article", { name: "What is next" });
    expect(within(next).getByText("None proposed.")).toBeInTheDocument();
    // A dependency that exists is named by its key as well.
    expect(within(next).getByText("RPT-3")).toBeInTheDocument();
  });

  it("approves the whole proposal from the canvas, and becomes the created item in the same tab", async () => {
    const { invoke } = proposing();
    open("/proposals/p1/0", invoke);

    // Labelled with everything it creates, not only the item open.
    const approve = await within(await canvas()).findByRole("button", { name: /^Create report and 3 / });
    fireEvent.click(approve);

    await waitFor(() => expect(sent(invoke, "assist:approve")).toEqual([{ conversationId: CONVERSATION_ID, messageId: "p1" }]));
    // The tab that showed the proposed item shows the item, without being reopened.
    await waitFor(() => expect(window.location.hash).toBe("#/items/i1"));
    expect(await within(await canvas()).findByRole("article", { name: "Week of 29 September" })).toBeInTheDocument();
    await waitFor(() => expect(openTabs().map((tab) => tab.textContent)).toEqual(["RPT-7"]));

    // And the card: no button, and its rows are links to what was created, by key.
    const proposal = await card();
    await waitFor(() => expect(within(proposal).queryByRole("button")).not.toBeInTheDocument());
    expect(within(proposal).getByText("Approved.")).toBeInTheDocument();
    expect(within(proposal).getAllByRole("link").map((link) => [link.getAttribute("href"), within(link).getByText(/^(RPT|INV)-\d+$/).textContent])).toEqual([
      ["#/items/i1", "RPT-7"],
      ["#/items/i2", "INV-14"],
      ["#/items/i3", "INV-11"],
    ]);
  });

  it("becomes the created item when the proposal is approved from the card instead", async () => {
    const { invoke } = proposing();
    open("/proposals/p1/2", invoke);
    await within(await canvas()).findByRole("article", { name: "What is next" });
    // A second proposed item, open in a tab behind it.
    fireEvent.click(within(await card()).getByRole("link", { name: /^What shipped/ }));
    await within(await canvas()).findByRole("article", { name: "What shipped" });
    expect(openTabs()).toHaveLength(2);

    fireEvent.click(within(await card()).getByRole("button", { name: /^Create / }));

    await waitFor(() => expect(window.location.hash).toBe("#/items/i1"));
    // In its own place in the row; the one behind it now reads as its item too, and opens as it.
    await waitFor(() => expect(openTabs().map((tab) => tab.textContent)).toEqual(["INV-11", "RPT-7"]));
    expect(within(await canvas()).queryByRole("button", { name: /^Create / })).not.toBeInTheDocument();
    fireEvent.click(openTabs()[0]!);
    await waitFor(() => expect(window.location.hash).toBe("#/items/i3"));
    await waitFor(() => expect(openTabs().map((tab) => tab.textContent)).toEqual(["INV-11", "RPT-7"]));
    expect(sent(invoke, "assist:approve")).toHaveLength(1);
  });

  it("creates the items once when both buttons are pressed, and reports nothing for the press that lost", async () => {
    const { invoke } = proposing();
    open("/proposals/p1/0", invoke);

    const inCanvas = await within(await canvas()).findByRole("button", { name: /^Create report and 3 / });
    const onCard = within(await card()).getByRole("button", { name: /^Create / });
    fireEvent.click(inCanvas);
    fireEvent.click(onCard);

    await waitFor(() => expect(window.location.hash).toBe("#/items/i1"));
    const answers = await Promise.all(invoke.mock.results.filter((_result, at) => invoke.mock.calls[at]![0] === "assist:approve").map((result) => result.value as Promise<{ data: { applied: boolean } }>));
    expect(answers.map((answer) => answer.data.applied)).toEqual([true, false]);
    const proposal = await card();
    await waitFor(() => expect(within(proposal).getByText("Approved.")).toBeInTheDocument());
    expect(proposal).not.toHaveTextContent("superseded or already applied");
  });

  it("still opens the items of a proposal a newer one replaced, saying so and offering no approve", async () => {
    const { invoke } = proposing("superseded");
    open("/chat", invoke);

    fireEvent.click(within(await card()).getByRole("link", { name: /^What shipped/ }));

    const view = within(await canvas());
    const item = await view.findByRole("article", { name: "What shipped" });
    expect(within(item).getByText("DESCRIPTION of what shipped, at length.")).toBeInTheDocument();
    expect(view.getByRole("status")).toHaveTextContent("replaced by a newer one");
    expect(view.queryByRole("button", { name: /^Create / })).not.toBeInTheDocument();
    expect(sent(invoke, "assist:approve")).toEqual([]);
  });

  it("hands the person to the composer to ask for a change, opening the conversation if it was folded", async () => {
    const { invoke } = proposing();
    open("/proposals/p1/1", invoke);
    await within(await canvas()).findByRole("article", { name: "What slipped" });

    fireEvent.click(within(screen.getByRole("region", { name: "Conversation" })).getByRole("button", { name: "Fold the conversation" }));
    expect(screen.queryByRole("region", { name: "Conversation" })).not.toBeInTheDocument();

    fireEvent.click(within(await canvas()).getByRole("button", { name: "Ask for a change" }));

    const column = await screen.findByRole("region", { name: "Conversation" });
    await waitFor(() => expect(within(column).getByRole("textbox", { name: "Message the assistant" })).toHaveFocus());
    // Asking is saying it: nothing is approved by it.
    expect(sent(invoke, "assist:approve")).toEqual([]);
  });

  it("shows the same proposed item when the window is reloaded on its address, and the created item once it is approved", async () => {
    const first = proposing();
    open("/proposals/p1/1", first.invoke);
    expect(await within(await canvas()).findByRole("article", { name: "What slipped" })).toBeInTheDocument();
    cleanup();

    // The same address, loaded afresh after the approval.
    const second = proposing("applied");
    open("/proposals/p1/1", second.invoke);
    await waitFor(() => expect(window.location.hash).toBe("#/items/i2"));
    await waitFor(() => expect(openTabs()).toHaveLength(1));
  });

  it("says so for an address whose proposal cannot be read", async () => {
    const { invoke } = proposing();
    open("/proposals/gone/0", invoke);

    expect(await within(await canvas()).findByText(/is not there any more/)).toBeInTheDocument();
    expect(within(await canvas()).queryByRole("button", { name: /^Create / })).not.toBeInTheDocument();
  });

  describe("in the canvas's own window", () => {
    afterEach(() => {
      cleanup();
      window.history.replaceState(null, "", "/");
    });

    it("is drawn and approved there", async () => {
      window.history.replaceState(null, "", "/?window=canvas");
      const { invoke } = proposing("open", { "canvas:state": { poppedOut: true, tabs: ["/proposals/p1/1"], active: "/proposals/p1/1" } });
      open("/proposals/p1/1", invoke);

      const view = within(await screen.findByRole("region", { name: "Canvas" }));
      expect(await view.findByRole("article", { name: "What slipped" })).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Conversation" })).not.toBeInTheDocument();
      // This is the window the assistant reads while the canvas is out.
      await waitFor(() => expect(sent(invoke, "view:publish").at(-1)).toMatchObject({ page: { route: "/proposals/:messageId/:index", params: { messageId: "p1", index: "1" } } }));

      fireEvent.click(view.getByRole("button", { name: /^Create report and 3 / }));
      await waitFor(() => expect(sent(invoke, "assist:approve")).toEqual([{ conversationId: CONVERSATION_ID, messageId: "p1" }]));
      await waitFor(() => expect(window.location.hash).toBe("#/items/i2"));
      await waitFor(() => expect(openTabs().map((tab) => tab.textContent)).toEqual(["INV-14"]));
    });

    // The conversation is in the main window, so asking for a change is
    // asking for that window: one call from here, and one push heard there.
    it("asks the main window for the composer, since the conversation is not in this one", async () => {
      window.history.replaceState(null, "", "/?window=canvas");
      const { invoke } = proposing("open", { "canvas:state": { poppedOut: true, tabs: ["/proposals/p1/1"], active: "/proposals/p1/1" }, "canvas:ask": { handed: true } });
      open("/proposals/p1/1", invoke);
      const view = within(await screen.findByRole("region", { name: "Canvas" }));
      await view.findByRole("article", { name: "What slipped" });
      expect(sent(invoke, "canvas:ask")).toEqual([]);

      fireEvent.click(view.getByRole("button", { name: "Ask for a change" }));

      await waitFor(() => expect(sent(invoke, "canvas:ask")).toHaveLength(1));
      expect(sent(invoke, "assist:approve")).toEqual([]);
    });

    it("puts the cursor in the main window's composer when the canvas window asks", async () => {
      const listeners = new Map<string, ((payload: unknown) => void)[]>();
      window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
        return () => {};
      }) as never;
      // The main window, with the canvas out: the conversation alone, at its full width.
      const { invoke } = proposing("open", { "canvas:state": { poppedOut: true, tabs: ["/proposals/p1/1"], active: "/proposals/p1/1" } });
      open("/chat", invoke);
      const composer = await screen.findByRole("textbox", { name: "Message the assistant" });
      expect(composer).not.toHaveFocus();

      act(() => (listeners.get("canvas:asked") ?? []).forEach((listener) => listener({})));

      await waitFor(() => expect(composer).toHaveFocus());
    });
  });
});

describe("the conversation beside a view", () => {
  it("starts folded beside a view drawn for the width, opens on one press, and folds back", async () => {
    open("/agents");

    fireEvent.click(await screen.findByRole("button", { name: "Show the conversation" }));
    const column = await screen.findByRole("region", { name: "Conversation" });
    fireEvent.click(within(column).getByRole("button", { name: "Fold the conversation" }));
    expect(screen.queryByRole("region", { name: "Conversation" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Show the conversation" })).toHaveLength(1);
  });

  it("starts open beside a board, and keeps a fold the person chose for that kind of view", async () => {
    open("/pipelines/p-report");
    await screen.findByRole("region", { name: "Canvas" });
    const column = screen.getByRole("region", { name: "Conversation" });
    expect(screen.queryByRole("button", { name: "Show the conversation" })).not.toBeInTheDocument();

    fireEvent.click(within(column).getByRole("button", { name: "Fold the conversation" }));
    window.location.hash = "#/pipelines/p-invoices";
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(screen.queryByRole("region", { name: "Conversation" })).not.toBeInTheDocument();
  });
});

describe("what is waiting on you, in the chat layout", () => {
  it("leaves out the assistant's own thread, whose reply box is the one on screen", async () => {
    const own = { ...INBOX.items[0]!, commentId: "own", itemId: conversation().id, itemKey: "ASK-1", itemTitle: "Assistance" };
    open("/chat", bridge({ "inbox:list": { items: [...INBOX.items, own], summary: { blockingCount: 2 } } }));

    const overview = await screen.findByRole("region", { name: "Overview" });
    expect(await within(overview).findByText("Week of 29 September")).toBeInTheDocument();
    await waitFor(() => expect(within(overview).queryByText("Assistance")).not.toBeInTheDocument());
    expect(within(rail()).getByText("1 waiting on you")).toBeInTheDocument();
  });
});

describe("the chat layout's rail", () => {
  it("reaches the Jobs screen for a project that has no job yet", async () => {
    open("/chat");
    fireEvent.click(await within(await screen.findByRole("navigation", { name: "Main" })).findByRole("button", { name: "New job" }));
    await waitFor(() => expect(window.location.hash).toBe("#/jobs"));
  });

  it("disables the pause control while its request is in flight, so a second press sends nothing (EO-562)", async () => {
    let land: (value: unknown) => void = () => {};
    const base = bridge();
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "engine:status") return { ok: true, data: { paused: false, activeRunCount: 0, finishingRunCount: 0 } };
      if (channel === "engine:pause") return new Promise<never>((resolve) => (land = resolve as (value: unknown) => void));
      return base(channel, payload);
    });
    open("/chat", invoke);
    const pause = await within(await screen.findByRole("navigation", { name: "Main" })).findByRole("button", { name: "Pause agent activity" });

    fireEvent.click(pause);
    fireEvent.click(pause);
    const pending = await within(rail()).findByRole("button", { name: "Pausing agent activity…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(invoke.mock.calls.filter(([channel]) => channel === "engine:pause")).toHaveLength(1);

    await act(async () => land({ ok: true, data: { paused: true, activeRunCount: 0, finishingRunCount: 0 } }));
    expect(await within(rail()).findByRole("button", { name: "Resume agent activity" })).toBeEnabled();
  });

  function openPaused(data: { activeRunCount: number; finishingRunCount: number }) {
    const base = bridge();
    open(
      "/chat",
      vi.fn(async (channel: string, payload?: unknown) => (channel === "engine:status" ? { ok: true, data: { paused: true, ...data } } : base(channel, payload))),
    );
  }

  it("does not call the system agent's runs finishing, and still offers Resume, while paused (EO-615)", async () => {
    openPaused({ activeRunCount: 1, finishingRunCount: 0 });

    const control = await within(await screen.findByRole("navigation", { name: "Main" })).findByRole("button", { name: "Resume agent activity" });

    expect(control).toBeEnabled();
    expect(control).toHaveAttribute("title", "Resume agent activity. The system agent carries on while paused.");
    expect(control.querySelector(".animate-spin")).toBeNull();
  });

  it("counts only the runs a pause is waiting for (EO-615)", async () => {
    openPaused({ activeRunCount: 3, finishingRunCount: 2 });

    expect(await within(await screen.findByRole("navigation", { name: "Main" })).findByRole("button", { name: "2 agents are finishing" })).toBeInTheDocument();
  });

  it("says on the pause control that the system agent carries on (EO-615)", async () => {
    open("/chat", bridge());

    const control = await within(await screen.findByRole("navigation", { name: "Main" })).findByRole("button", { name: "Pause agent activity" });

    expect(control).toHaveAttribute("title", "Pause agent activity. The system agent carries on while paused.");
  });

  it("shows the board loading, not the previous project's items, until the new project's arrive (EO-562)", async () => {
    let active = "a";
    let landItems: (value: unknown) => void = () => {};
    const projects = () => ({
      projects: [
        { id: "a", name: "Finance", keyPrefix: "FIN", repositoryIds: [], itemCount: 0, costCents: 0 },
        { id: "b", name: "Operations", keyPrefix: "OPS", repositoryIds: [], itemCount: 0, costCents: 0 },
      ],
      activeProjectId: active,
    });
    const base = bridge();
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "projects:list") return { ok: true, data: projects() };
      if (channel === "projects:setActive") {
        active = (payload as { id: string }).id;
        return { ok: true, data: {} };
      }
      if (channel === "items:list" && active === "b") return new Promise<never>((resolve) => (landItems = resolve as (value: unknown) => void));
      return base(channel, payload);
    });
    open("/pipelines/p-report", invoke);
    const canvas = await screen.findByRole("region", { name: "Canvas" });
    expect(await within(canvas).findByText("Week of 29 September")).toBeInTheDocument();

    fireEvent.click(await within(rail()).findByRole("button", { name: "Switch project" }));
    fireEvent.click(await screen.findByRole("button", { name: "Operations" }));

    await waitFor(() => expect(within(canvas).queryByText("Week of 29 September")).not.toBeInTheDocument());
    expect(within(canvas).getByText("Loading…")).toBeInTheDocument();
    await waitFor(() => expect(within(rail()).getByRole("button", { name: "Switch project" })).toHaveTextContent("Operations"));

    await act(async () => landItems({ ok: true, data: { items: [item({ id: "o1", key: "OPS-1", title: "Quarterly audit", stepId: "s-gather", stepName: "Gather" })] } }));
    expect(await within(canvas).findByText("Quarterly audit")).toBeInTheDocument();
    expect(within(canvas).queryByText("Loading…")).not.toBeInTheDocument();
    expect(within(canvas).queryByText("Week of 29 September")).not.toBeInTheDocument();
  });

  it("starts a new chat beside the open one, clearing nothing", async () => {
    const invoke = open("/chat", bridge({ "assist:new": { conversation: conversation() } }));
    fireEvent.click(await within(await screen.findByRole("navigation", { name: "Main" })).findByRole("button", { name: "New chat" }));
    await waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === "assist:new")).toBe(true));
    // New chat is not Clear (EO-391): the chat that was open is not put away.
    expect(invoke.mock.calls.some(([channel]) => channel === "assist:clear")).toBe(false);
  });

  describe("its chats", () => {
    const thread = (id: string, title: string, live = false, shown = live) => ({ id, key: `ASK-${id}`, title, startedAt: 1, lastActivityAt: 2, live, shown });
    const railReady = () => screen.findByRole("navigation", { name: "Main" });

    it("lists the open chat by what was said first, then the earlier ones, and goes back to one", async () => {
      const earlier = { ...conversation(), id: "older", key: "ASK-2" };
      const invoke = open(
        "/inbox",
        bridge({
          "assist:list": { conversations: [thread("live", "What is waiting on me?", true), thread("older", "Why is the weekly report late?")] },
          "assist:resume": { conversation: earlier, problem: null },
        }),
      );

      expect(await within(await railReady()).findByRole("link", { name: "What is waiting on me?" })).toHaveAttribute("href", "#/chat");
      const list = within(rail()).getByRole("list", { name: "Earlier chats" });
      fireEvent.click(within(list).getByRole("button", { name: "Why is the weekly report late?" }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:resume", { conversationId: "older" }));
      await waitFor(() => expect(window.location.hash).toBe("#/chat"));
    });

    it("calls an open chat nobody has said anything in by the room's name, and lists no earlier ones it does not have", async () => {
      open("/chat", bridge({ "assist:list": { conversations: [] } }));
      expect(await within(await railReady()).findByRole("link", { name: "Assistant" })).toBeInTheDocument();
      expect(within(rail()).queryByRole("list", { name: "Earlier chats" })).not.toBeInTheDocument();
    });

    it("shows the six newest earlier chats, and the rest on asking", async () => {
      const earlier = Array.from({ length: 9 }, (_, index) => thread(`t${index}`, `Question ${index}`));
      open("/chat", bridge({ "assist:list": { conversations: [thread("live", "Now", true), ...earlier] } }));

      const list = await within(await railReady()).findByRole("list", { name: "Earlier chats" });
      expect(within(list).getAllByRole("button").map((button) => button.textContent)).toEqual(earlier.slice(0, 6).map((entry) => entry.title));
      fireEvent.click(within(rail()).getByRole("button", { name: "Show all 9" }));
      expect(within(list).getAllByRole("button")).toHaveLength(9);
    });

    it("says so when the channel itself fails, and stays where it was", async () => {
      const base = bridge({ "assist:list": { conversations: [thread("live", "Now", true), thread("old", "An old question")] } });
      open(
        "/inbox",
        vi.fn(async (channel: string, payload?: unknown) =>
          channel === "assist:resume" ? { ok: false, error: { message: "The database is locked." } } : base(channel, payload),
        ) as unknown as ReturnType<typeof bridge>,
      );
      fireEvent.click(await within(await railReady()).findByRole("button", { name: "An old question" }));
      expect(await within(rail()).findByText("The database is locked.")).toBeInTheDocument();
      expect(window.location.hash).toBe("#/inbox");
    });

    it("says why going back did not happen, in the main process's words", async () => {
      open(
        "/chat",
        bridge({
          "assist:list": { conversations: [thread("live", "Now", true), thread("gone", "An old question")] },
          "assist:resume": { conversation: conversation(), problem: "That is not one of your conversations with the assistant." },
        }),
      );
      fireEvent.click(await within(await railReady()).findByRole("button", { name: "An old question" }));
      expect(await within(rail()).findByText("That is not one of your conversations with the assistant.")).toBeInTheDocument();
    });
  });

  describe("several open chats", () => {
    const thread = (id: string, title: string, live: boolean, shown: boolean) => ({ id, key: `ASK-${id}`, title, startedAt: 1, lastActivityAt: 2, live, shown });
    const SEVERAL = {
      conversations: [
        thread("b", "What does Hold do?", true, true),
        thread("a", "Rework the release pipeline.", true, false),
        thread("old", "Why is the weekly report late?", false, false),
      ],
    };

    it("lists the open ones apart from the ones put away, and the one on show as the conversation", async () => {
      open("/chat", bridge({ "assist:list": SEVERAL }));
      const nav = await screen.findByRole("navigation", { name: "Main" });

      expect(await within(nav).findByRole("link", { name: "What does Hold do?" })).toBeInTheDocument();
      const openOnes = within(nav).getByRole("list", { name: "Open chats" });
      expect(within(openOnes).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["What does Hold do?", "Rework the release pipeline."]);
      const earlier = within(nav).getByRole("list", { name: "Earlier chats" });
      expect(within(earlier).getAllByRole("button").map((row) => row.textContent)).toEqual(["Why is the weekly report late?"]);
    });

    it("switches to another open chat with assist:resume, and clears nothing", async () => {
      const other = { ...conversation(), id: "a", key: "ASK-1" };
      const invoke = open("/inbox", bridge({ "assist:list": SEVERAL, "assist:resume": { conversation: other, problem: null } }));
      const nav = await screen.findByRole("navigation", { name: "Main" });

      fireEvent.click(await within(nav).findByRole("button", { name: "Rework the release pipeline." }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:resume", { conversationId: "a" }));
      await waitFor(() => expect(window.location.hash).toBe("#/chat"));
      expect(invoke.mock.calls.some(([channel]) => channel === "assist:clear")).toBe(false);
    });

    it("warns that removing an open chat cancels what it is running, and only the one on show leaves an empty chat", async () => {
      open("/chat", bridge({ "assist:list": SEVERAL }));
      const nav = await screen.findByRole("navigation", { name: "Main" });

      fireEvent.contextMenu(await within(nav).findByRole("button", { name: "Rework the release pipeline." }), { clientX: 40, clientY: 120 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
      const dialog = screen.getByRole("dialog", { name: "Remove “Rework the release pipeline.”?" });
      expect(dialog).toHaveTextContent("Anything it is running is cancelled.");
      expect(dialog).not.toHaveTextContent("You are left in a new, empty chat.");
    });
  });

  /**
   * EO-438. The chat on show used to be drawn as a row of its own above
   * the others, so whichever chat was opened jumped to the top. It is a
   * row of the one list now, where `assist:list` puts it.
   */
  describe("the order of the open chats", () => {
    // A drag leaves dnd-kit swallowing document clicks for 50ms after the
    // drop (`AbstractPointerSensor.detach` removes its click listener on a
    // timer), and the next case's first click landed inside that window
    // whenever it started quickly: "Move down" was clicked and nothing ran.
    // Each case waits it out, so none inherits another's drag.
    afterEach(() => new Promise((resolve) => setTimeout(resolve, 60)));

    const thread = (id: string, title: string, live: boolean, shown: boolean) => ({ id, key: `ASK-${id}`, title, startedAt: 1, lastActivityAt: 2, live, shown });
    const three = (shown: string) => ({
      conversations: [
        thread("a", "Rework the release pipeline.", true, shown === "a"),
        thread("b", "What does Hold do?", true, shown === "b"),
        thread("c", "Why is the weekly report late?", true, shown === "c"),
        thread("old", "An old question", false, false),
      ],
    });
    const TITLES = ["Rework the release pipeline.", "What does Hold do?", "Why is the weekly report late?"] as const;
    const nav = () => screen.findByRole("navigation", { name: "Main" });
    const openRows = async () => within(within(await nav()).getByRole("list", { name: "Open chats" })).getAllByRole("listitem");

    /**
     * A drag leaves the document deaf to clicks for a moment after it.
     * dnd-kit stops every click at the document while a drag is under
     * way, so the click that ends one opens nothing, and takes that
     * listener off 50ms after the drag ends. One `document` serves the
     * whole file, so a test that began inside those 50ms lost its first
     * click: the Move down after a drag test went nowhere, and the test
     * failed on the release run while it passed alone. So a test that
     * dragged does not end until a click gets through again.
     */
    afterEach(async () => {
      const probe = document.createElement("button");
      let heard = false;
      probe.addEventListener("click", () => {
        heard = true;
      });
      document.body.append(probe);
      try {
        await waitFor(() => {
          probe.click();
          expect(heard).toBe(true);
        });
      } finally {
        probe.remove();
      }
    });
    const titles = async () => (await openRows()).map((row) => row.textContent);

    it("shows the chat that was clicked where it already stood, as the current one, with no row above the list", async () => {
      // The main process's answer to going to the third: the same order, another one shown.
      let shown = "a";
      const base = bridge({ "assist:resume": { conversation: { ...conversation(), id: "c", key: "ASK-c" }, problem: null } });
      const invoke = open(
        "/chat",
        vi.fn(async (channel: string, payload?: unknown) => {
          if (channel === "assist:list") return { ok: true, data: three(shown) };
          if (channel === "assist:resume") shown = "c";
          return base(channel, payload);
        }) as unknown as ReturnType<typeof bridge>,
      );
      const rail = await nav();
      expect(await within(rail).findByRole("link", { name: TITLES[0] })).toHaveAttribute("aria-current", "page");
      expect(await titles()).toEqual(TITLES);

      fireEvent.click(within(rail).getByRole("button", { name: TITLES[2] }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:resume", { conversationId: "c" }));
      // The third is the current one, third; the first is a row like the second.
      expect(await within(rail).findByRole("link", { name: TITLES[2] })).toHaveAttribute("aria-current", "page");
      expect(await titles()).toEqual(TITLES);
      expect(within(rail).getByRole("button", { name: TITLES[0] })).toBeInTheDocument();
      // Every row for an open chat is in the list: nothing is drawn above it for the one on show.
      expect(within(rail).getAllByRole("link", { name: TITLES[2] })).toHaveLength(1);
      expect((await openRows())[2]).toContainElement(within(rail).getByRole("link", { name: TITLES[2] }));
      expect(invoke.mock.calls.some(([channel]) => channel === "assist:reorder")).toBe(false);
    });

    /**
     * The chat on show is a link, and a link answers Enter alone. The
     * rows beside it are buttons, which answer Space too — so from the
     * inbox, Space on the current row has to be made to open it.
     */
    it("opens the chat on show with Space from another page, as its neighbours open, and keeps the menu keys", async () => {
      const invoke = open("/inbox", bridge({ "assist:list": three("b") }));
      const row = await within(await nav()).findByRole("link", { name: TITLES[1] });
      expect(row).not.toHaveAttribute("aria-current");

      // The menu's keys are still the menu's, and go nowhere.
      row.focus();
      fireEvent.keyDown(row, { key: "F10", shiftKey: true });
      expect(screen.getByRole("menuitem", { name: "Remove" })).toBeInTheDocument();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      expect(window.location.hash).toBe("#/inbox");

      // Space is taken, so the page does not scroll under it instead.
      expect(fireEvent.keyDown(row, { key: " " })).toBe(false);

      await waitFor(() => expect(window.location.hash).toBe("#/chat"));
      await waitFor(() => expect(row).toHaveAttribute("aria-current", "page"));
      // It was already the chat on show: nothing is resumed, and nothing moves.
      expect(await titles()).toEqual(TITLES);
      expect(invoke.mock.calls.some(([channel]) => channel === "assist:resume" || channel === "assist:reorder")).toBe(false);
    });

    it("moves a row pressed and dragged to another place with assist:reorder, and opens nothing on the way", async () => {
      const listed = three("a");
      const [a, b, c, old] = listed.conversations as [ReturnType<typeof thread>, ReturnType<typeof thread>, ReturnType<typeof thread>, ReturnType<typeof thread>];
      const invoke = open("/chat", bridge({ "assist:list": listed, "assist:reorder": { conversations: [c, a, b, old], problem: null } }));
      await within(await nav()).findByRole("button", { name: TITLES[2] });
      // jsdom lays nothing out: each row is given the box it would have, thirty pixels under the one before.
      const rows = await openRows();
      rows.forEach((row, index) => {
        row.getBoundingClientRect = () => new DOMRect(0, index * 30, 230, 30);
      });
      const dragged = within(rows[2]!).getByRole("button");

      fireEvent.pointerDown(dragged, { button: 0, isPrimary: true, clientX: 20, clientY: 75 });
      // Past the four pixels that make a press a drag, then up to the first row.
      fireEvent.pointerMove(document, { clientX: 20, clientY: 60 });
      fireEvent.pointerMove(document, { clientX: 20, clientY: 12 });
      fireEvent.pointerUp(document, { clientX: 20, clientY: 12 });

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:reorder", { conversationId: "c", index: 0 }));
      await waitFor(async () => expect(await titles()).toEqual([TITLES[2], TITLES[0], TITLES[1]]));
      expect(invoke.mock.calls.some(([channel]) => channel === "assist:resume")).toBe(false);
    });

    it("moves a chat one place up or down from its menu with assist:reorder, and draws the order that comes back", async () => {
      const listed = three("a");
      const [a, b, c, old] = listed.conversations as [ReturnType<typeof thread>, ReturnType<typeof thread>, ReturnType<typeof thread>, ReturnType<typeof thread>];
      const invoke = open("/chat", bridge({ "assist:list": listed, "assist:reorder": { conversations: [a, c, b, old], problem: null } }));
      const rail = await nav();
      const second = await within(rail).findByRole("button", { name: TITLES[1] });

      // The keyboard's way to the menu: Enter and Space are left to open the chat.
      second.focus();
      fireEvent.keyDown(second, { key: "F10", shiftKey: true });
      expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual(["Move up", "Move down", "Remove"]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Move down" }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:reorder", { conversationId: "b", index: 2 }));
      await waitFor(async () => expect(await titles()).toEqual([TITLES[0], TITLES[2], TITLES[1]]));
      // Moving a chat is not opening it.
      expect(invoke.mock.calls.some(([channel]) => channel === "assist:resume")).toBe(false);
    });

    it("offers only the moves there are: none past either end, and none on an earlier chat", async () => {
      const invoke = open("/chat", bridge({ "assist:list": three("a"), "assist:reorder": { ...three("a"), problem: null } }));
      const rail = await nav();
      const entries = (row: HTMLElement) => {
        fireEvent.contextMenu(row, { clientX: 40, clientY: 120 });
        const found = within(screen.getByRole("menu")).getAllByRole("menuitem").map((entry) => entry.textContent);
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        return found;
      };

      expect(entries(await within(rail).findByRole("link", { name: TITLES[0] }))).toEqual(["Move down", "Remove"]);
      expect(entries(within(rail).getByRole("button", { name: TITLES[2] }))).toEqual(["Move up", "Remove"]);
      expect(entries(within(rail).getByRole("button", { name: "An old question" }))).toEqual(["Remove"]);

      // The one on show moves like any other, by its own menu.
      fireEvent.contextMenu(within(rail).getByRole("link", { name: TITLES[0] }), { clientX: 40, clientY: 120 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:reorder", { conversationId: "a", index: 1 }));
    });

    it("says why a move did not happen, in the main process's words", async () => {
      open("/chat", bridge({ "assist:list": three("a"), "assist:reorder": { ...three("a"), problem: "That chat is not open any more, so it was not moved." } }));
      const rail = await nav();
      fireEvent.contextMenu(await within(rail).findByRole("button", { name: TITLES[1] }), { clientX: 40, clientY: 120 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
      expect(await within(rail).findByText("That chat is not open any more, so it was not moved.")).toBeInTheDocument();
      expect(await titles()).toEqual(TITLES);
    });

    /**
     * EO-439: the drop is the rail's, and storing it is background work.
     * Every case below holds `assist:reorder`'s replies until it lets them
     * go, so what the rail draws meanwhile is what it drew on its own.
     */
    describe("while the move is being stored", () => {
      type Thread = ReturnType<typeof thread>;
      const [a, b, c, old] = three("a").conversations as [Thread, Thread, Thread, Thread];
      /** The open chats' titles as they stand this moment — no waiting for them to change. */
      const titlesNow = () => within(within(rail()).getByRole("list", { name: "Open chats" })).getAllByRole("listitem").map((row) => row.textContent);
      const ordered = (...threads: Thread[]) => threads.map((one) => one.title);

      /** A bridge whose `assist:reorder` answers wait, in the order they were asked, until `reply` lets one go. */
      const holding = () => {
        const held: ((answer: unknown) => void)[] = [];
        const base = bridge({ "assist:list": three("a") });
        const invoke = vi.fn((channel: string, payload?: unknown) =>
          channel === "assist:reorder" ? new Promise((answer) => held.push(answer)) : base(channel, payload),
        ) as unknown as ReturnType<typeof bridge>;
        const reply = async (index: number, answer: unknown) => {
          await waitFor(() => expect(held.length).toBeGreaterThan(index));
          await act(async () => held[index]!(answer));
        };
        return { invoke, reply };
      };

      /** Presses the open chat at `index` and lets it go at `y`, every row thirty pixels under the one before. */
      const drag = async (index: number, y: number) => {
        const rows = await openRows();
        rows.forEach((row, at) => {
          row.getBoundingClientRect = () => new DOMRect(0, at * 30, 230, 30);
        });
        const pressed = rows[index]!.firstElementChild as HTMLElement;
        fireEvent.pointerDown(pressed, { button: 0, isPrimary: true, clientX: 20, clientY: index * 30 + 15 });
        fireEvent.pointerMove(document, { clientX: 20, clientY: index * 30 + 5 });
        fireEvent.pointerMove(document, { clientX: 20, clientY: y });
        fireEvent.pointerUp(document, { clientX: 20, clientY: y });
      };

      const menuMove = (title: string, entry: "Move up" | "Move down") => {
        // The row itself, a link for the chat on show and a button for the others.
        const row = within(within(rail()).getByRole("list", { name: "Open chats" }))
          .getAllByRole("listitem")
          .find((item) => item.textContent === title)!.firstElementChild as HTMLElement;
        fireEvent.contextMenu(row, { clientX: 40, clientY: 120 });
        fireEvent.click(screen.getByRole("menuitem", { name: entry }));
      };

      it("draws a dropped chat in its new place the moment it is let go", async () => {
        const { invoke } = holding();
        open("/chat", invoke);
        await within(await nav()).findByRole("button", { name: TITLES[2] });

        await drag(2, 12);

        expect(titlesNow()).toEqual(ordered(c, a, b));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:reorder", { conversationId: "c", index: 0 }));
        expect(titlesNow()).toEqual(ordered(c, a, b));
      });

      it("draws Move up and Move down at once too", async () => {
        const { invoke } = holding();
        open("/chat", invoke);
        await within(await nav()).findByRole("button", { name: TITLES[2] });

        menuMove(TITLES[1], "Move down");
        expect(titlesNow()).toEqual(ordered(a, c, b));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:reorder", { conversationId: "b", index: 2 }));

        menuMove(TITLES[0], "Move down");
        expect(titlesNow()).toEqual(ordered(c, a, b));
        menuMove(TITLES[1], "Move up");
        expect(titlesNow()).toEqual(ordered(c, b, a));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:reorder", { conversationId: "b", index: 1 }));
      });

      it("ends on the second of two quick moves, and never draws the first's reply on the way", async () => {
        const { invoke, reply } = holding();
        open("/chat", invoke);
        await within(await nav()).findByRole("button", { name: TITLES[2] });
        const drawn: (string | null)[][] = [];
        const watching = new MutationObserver(() => drawn.push(titlesNow()));
        watching.observe(within(rail()).getByRole("list", { name: "Open chats" }), { childList: true, subtree: true, characterData: true });

        // Down to the bottom, then up to the top before the first has been stored.
        await drag(0, 75);
        expect(titlesNow()).toEqual(ordered(b, c, a));
        await drag(1, 12);
        expect(titlesNow()).toEqual(ordered(c, b, a));
        await waitFor(() => expect(invoke.mock.calls.filter(([channel]) => channel === "assist:reorder")).toHaveLength(2));
        drawn.length = 0;

        await reply(0, { ok: true, data: { conversations: [b, c, a, old], problem: null } });
        expect(titlesNow()).toEqual(ordered(c, b, a));
        await reply(1, { ok: true, data: { conversations: [c, b, a, old], problem: null } });
        expect(titlesNow()).toEqual(ordered(c, b, a));
        await act(async () => {});

        watching.disconnect();
        expect(drawn).not.toContainEqual(ordered(b, c, a));
        expect(titlesNow()).toEqual(ordered(c, b, a));
      });

      it("goes back to the stored order, and says why, when the write fails", async () => {
        const { invoke, reply } = holding();
        open("/chat", invoke);
        await within(await nav()).findByRole("button", { name: TITLES[2] });

        await drag(2, 12);
        expect(titlesNow()).toEqual(ordered(c, a, b));
        await reply(0, { ok: false, error: { message: "The database is locked." } });

        expect(await within(rail()).findByText("The database is locked.")).toBeInTheDocument();
        await waitFor(() => expect(titlesNow()).toEqual(ordered(a, b, c)));
      });

      it("goes back to the stored order, and says why, when the move is refused", async () => {
        const { invoke, reply } = holding();
        open("/chat", invoke);
        await within(await nav()).findByRole("button", { name: TITLES[2] });

        menuMove(TITLES[1], "Move up");
        expect(titlesNow()).toEqual(ordered(b, a, c));
        await reply(0, { ok: true, data: { conversations: [a, b, c, old], problem: "That chat is not open any more, so it was not moved." } });

        expect(await within(rail()).findByText("That chat is not open any more, so it was not moved.")).toBeInTheDocument();
        expect(titlesNow()).toEqual(ordered(a, b, c));
      });

      it("asks again for the chat lists after a move, and for nothing drawn from items", async () => {
        const listeners = new Map<string, ((payload: unknown) => void)[]>();
        window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: unknown) => void) => {
          listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
          return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((listener) => listener !== callback));
        }) as never;
        let stored = [a, b, c, old];
        const base = bridge();
        // The main process as it is: the move stored, the push sent, then the answer.
        const invoke = vi.fn(async (channel: string, payload?: unknown) => {
          if (channel === "assist:list") return { ok: true, data: { conversations: stored } };
          if (channel === "assist:reorder") {
            stored = [c, a, b, old];
            (listeners.get("assist:changed") ?? []).forEach((listener) => listener({}));
            return { ok: true, data: { conversations: stored, problem: null } };
          }
          return base(channel, payload);
        }) as unknown as ReturnType<typeof bridge>;
        open("/chat", invoke);
        await within(await nav()).findByRole("button", { name: TITLES[2] });
        // Everything the window asks for when it opens, asked.
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("inbox:list", undefined));
        await act(async () => {});
        const before = invoke.mock.calls.length;

        await drag(2, 12);

        await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:reorder", { conversationId: "c", index: 0 }));
        const since = () => invoke.mock.calls.slice(before).map(([channel]) => channel);
        await waitFor(() => expect(since()).toContain("assist:list"));
        await act(async () => {});
        expect(since().filter((channel) => ["assist:open", "items:list", "inbox:list", "pipelines:list", "items:get"].includes(channel))).toEqual([]);
        expect(titlesNow()).toEqual(ordered(c, a, b));
      });
    });
  });

  describe("removing a chat", () => {
    const thread = (id: string, title: string, live = false, shown = live) => ({ id, key: `ASK-${id}`, title, startedAt: 1, lastActivityAt: 2, live, shown });
    const THREADS = { conversations: [thread("live", "What is waiting on me?", true), thread("older", "Why is the weekly report late?")] };
    const openRow = async () => within(await screen.findByRole("navigation", { name: "Main" })).findByRole("link", { name: "What is waiting on me?" });
    const earlierRow = async () => within(await screen.findByRole("navigation", { name: "Main" })).findByRole("button", { name: "Why is the weekly report late?" });
    const called = (invoke: ReturnType<typeof bridge>, channel: string) => invoke.mock.calls.filter(([name]) => name === channel);

    it("opens a menu with one entry, Remove, on a right-click of either kind of row, at the pointer", async () => {
      const invoke = open("/inbox", bridge({ "assist:list": THREADS }));

      for (const row of [await earlierRow(), await openRow()]) {
        fireEvent.contextMenu(row, { clientX: 40, clientY: 120 });
        const menu = screen.getByRole("menu");
        expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual(["Remove"]);
        expect(menu).toHaveStyle({ top: "120px", left: "40px" });
        expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveFocus();

        // A click outside it closes it, back on the row it was opened from.
        fireEvent.click([...document.querySelectorAll("button[aria-hidden].fixed")].at(-1)!);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(row).toHaveFocus();
      }

      // A right-click opened nothing and went nowhere, and nothing was removed.
      expect(called(invoke, "assist:resume")).toEqual([]);
      expect(called(invoke, "assist:remove")).toEqual([]);
      expect(window.location.hash).toBe("#/inbox");
    });

    it("opens the same menu from the focused row with the context-menu key and Shift+F10, and Escape goes back to the row", async () => {
      open("/chat", bridge({ "assist:list": THREADS }));

      for (const row of [await earlierRow(), await openRow()]) {
        for (const key of [{ key: "ContextMenu" }, { key: "F10", shiftKey: true }]) {
          row.focus();
          fireEvent.keyDown(row, key);
          expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveFocus();
          fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
          expect(screen.queryByRole("menu")).not.toBeInTheDocument();
          expect(row).toHaveFocus();
        }
        // F10 alone is not asking for a menu.
        fireEvent.keyDown(row, { key: "F10" });
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      }
    });

    it("offers the same menu on an open chat nobody has said anything in, and removes it by the room's id", async () => {
      const fresh = { ...conversation(), id: "fresh", key: "ASK-9" };
      // The list has not named a live chat: the room the conversation holds does.
      const invoke = open("/chat", bridge({ "assist:list": { conversations: [] }, "assist:remove": { removed: true, conversation: fresh } }));
      const row = await within(await screen.findByRole("navigation", { name: "Main" })).findByRole("link", { name: "Assistant" });
      await waitFor(() => expect(row).toHaveAttribute("aria-haspopup", "menu"));

      for (const key of [{ key: "ContextMenu" }, { key: "F10", shiftKey: true }]) {
        row.focus();
        fireEvent.keyDown(row, key);
        expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveFocus();
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        expect(row).toHaveFocus();
      }

      fireEvent.contextMenu(row, { clientX: 40, clientY: 120 });
      expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual(["Remove"]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "Remove “Assistant”?" })).getByRole("button", { name: "Remove chat" }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:remove", { conversationId: conversation().id }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("warns before removing, by the chat's title, and removes nothing on Keep chat, Escape or the scrim", async () => {
      const invoke = open("/chat", bridge({ "assist:list": THREADS }));
      const row = await earlierRow();
      const warn = () => {
        fireEvent.contextMenu(row, { clientX: 40, clientY: 120 });
        fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
        return screen.getByRole("dialog", { name: "Remove “Why is the weekly report late?”?" });
      };

      const dialog = warn();
      expect(dialog).toHaveTextContent("permanently removed and cannot be recovered");
      expect(dialog).toHaveTextContent("Its messages, run history, queued requests and attachments go with it.");
      // What cannot be undone opens on the button that keeps it.
      expect(within(dialog).getByRole("button", { name: "Keep chat" })).toHaveFocus();
      expect(within(dialog).getByRole("button", { name: "Remove chat" })).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "Keep chat" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(row).toHaveFocus();

      warn();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      warn();
      fireEvent.click(document.querySelector(".bg-scrim")!);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      expect(called(invoke, "assist:remove")).toEqual([]);
      expect(await earlierRow()).toBeInTheDocument();
    });

    it("removes an earlier chat on the danger button, holds the dialog while it does, and drops the row without a reload", async () => {
      let threads = THREADS;
      let finish: (value: unknown) => void = () => undefined;
      const base = bridge();
      const invoke = open(
        "/inbox",
        vi.fn(async (channel: string, payload?: unknown) => {
          if (channel === "assist:list") return { ok: true, data: threads };
          if (channel === "assist:remove") return new Promise((resolve) => (finish = resolve));
          return base(channel, payload);
        }) as unknown as ReturnType<typeof bridge>,
      );
      fireEvent.contextMenu(await earlierRow(), { clientX: 40, clientY: 120 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
      const dialog = screen.getByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove chat" }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:remove", { conversationId: "older" }));
      // In flight: neither button answers, and nothing dismisses it.
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Keep chat" })).toBeDisabled());
      expect(within(dialog).getByRole("button", { name: "Removing…" })).toBeDisabled();
      fireEvent.keyDown(document, { key: "Escape" });
      fireEvent.click(document.querySelector(".bg-scrim")!);
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      threads = { conversations: [THREADS.conversations[0]!] };
      await act(async () => finish({ ok: true, data: { removed: true, conversation: null } }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(within(rail()).queryByRole("button", { name: "Why is the weekly report late?" })).not.toBeInTheDocument());
      // The open chat is where it was, and so is the person.
      expect(await openRow()).toBeInTheDocument();
      expect(window.location.hash).toBe("#/inbox");
    });

    it("removes the open chat and leaves the person in the new empty one", async () => {
      const said = message({ id: "m1", authorType: "human", authorName: "You", body: "What is waiting on me?" });
      const fresh = { ...conversation(), id: "fresh", key: "ASK-9" };
      let removed = false;
      const base = bridge();
      const invoke = open(
        "/inbox",
        vi.fn(async (channel: string, payload?: unknown) => {
          if (channel === "assist:list") return { ok: true, data: removed ? { conversations: [thread("fresh", "Assistant", true), THREADS.conversations[1]!] } : THREADS };
          if (channel === "assist:open") return { ok: true, data: { conversation: removed ? fresh : conversation([said]) } };
          if (channel === "assist:remove") {
            removed = true;
            return { ok: true, data: { removed: true, conversation: fresh } };
          }
          return base(channel, payload);
        }) as unknown as ReturnType<typeof bridge>,
      );
      fireEvent.contextMenu(await openRow(), { clientX: 40, clientY: 120 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
      const dialog = screen.getByRole("dialog", { name: "Remove “What is waiting on me?”?" });
      expect(dialog).toHaveTextContent("Anything it is running is cancelled. You are left in a new, empty chat.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove chat" }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:remove", { conversationId: "live" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      // As New chat leaves it: the conversation, under the room's own name, with the earlier chat still listed.
      await waitFor(() => expect(window.location.hash).toBe("#/chat"));
      expect(await within(rail()).findByRole("link", { name: "Assistant" })).toBeInTheDocument();
      expect(within(rail()).getByRole("button", { name: "Why is the weekly report late?" })).toBeInTheDocument();
    });

    it("keeps the warning open with the reason when the removal is refused or fails", async () => {
      const base = bridge({ "assist:list": THREADS });
      let answer: unknown = { ok: true, data: { removed: false, problem: "That is not one of your conversations with the assistant. It may already have been removed." } };
      open(
        "/chat",
        vi.fn(async (channel: string, payload?: unknown) => (channel === "assist:remove" ? answer : base(channel, payload))) as unknown as ReturnType<typeof bridge>,
      );
      fireEvent.contextMenu(await earlierRow(), { clientX: 40, clientY: 120 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
      const dialog = screen.getByRole("dialog");

      fireEvent.click(within(dialog).getByRole("button", { name: "Remove chat" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("That is not one of your conversations with the assistant.");

      answer = { ok: false, error: { message: "The database is locked." } };
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove chat" }));
      await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("The database is locked."));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("drops a chat removed in another window when the main process says items changed", async () => {
      const listeners: ((payload: unknown) => void)[] = [];
      const subscribe = window.eo.ipc.subscribe;
      window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: unknown) => void) => {
        if (channel === "items:changed") listeners.push(callback);
        return () => undefined;
      }) as never;
      try {
        let threads = THREADS;
        const base = bridge();
        open(
          "/chat",
          vi.fn(async (channel: string, payload?: unknown) => (channel === "assist:list" ? { ok: true, data: threads } : base(channel, payload))) as unknown as ReturnType<typeof bridge>,
        );
        expect(await earlierRow()).toBeInTheDocument();

        threads = { conversations: [THREADS.conversations[0]!] };
        act(() => listeners.forEach((listener) => listener({})));

        await waitFor(() => expect(within(rail()).queryByRole("button", { name: "Why is the weekly report late?" })).not.toBeInTheDocument());
      } finally {
        window.eo.ipc.subscribe = subscribe;
      }
    });
  });

  /** EO-442: several chats chosen, by modifier clicks or in select mode, and removed behind one warning. */
  describe("selecting several chats", () => {
    const thread = (id: string, title: string, live = false, shown = live) => ({ id, key: `ASK-${id}`, title, startedAt: 1, lastActivityAt: 2, live, shown });
    const OPEN = [thread("b", "What does Hold do?", true, true), thread("a", "Rework the release pipeline.", true, false)];
    const EARLIER = Array.from({ length: 9 }, (_, index) => thread(`t${index}`, `Question ${index}`));
    const LISTED = { conversations: [...OPEN, ...EARLIER] };
    const nav = () => screen.findByRole("navigation", { name: "Main" });
    const called = (invoke: ReturnType<typeof bridge>, channel: string) => invoke.mock.calls.filter(([name]) => name === channel);
    const earlierRow = (title: string) => within(within(rail()).getByRole("list", { name: "Earlier chats" })).getByRole("button", { name: title });
    const count = () => within(rail()).queryByRole("group", { name: "Selected chats" });
    const isSelected = (row: HTMLElement) => row.getAttribute("aria-description") === "Selected";

    it("toggles a row with Ctrl-click or ⌘-click in either list, opening nothing, and marks it", async () => {
      const invoke = open("/inbox", bridge({ "assist:list": LISTED }));
      const shownRow = await within(await nav()).findByRole("link", { name: "What does Hold do?" });
      const other = within(rail()).getByRole("button", { name: "Rework the release pipeline." });

      // The link's default is prevented: no route, and no window for a modified click on a link.
      expect(fireEvent.click(shownRow, { ctrlKey: true })).toBe(false);
      expect(fireEvent.click(earlierRow("Question 2"), { metaKey: true })).toBe(false);
      fireEvent.click(other, { ctrlKey: true });

      expect(isSelected(shownRow)).toBe(true);
      expect(isSelected(other)).toBe(true);
      expect(isSelected(earlierRow("Question 2"))).toBe(true);
      expect(isSelected(earlierRow("Question 1"))).toBe(false);
      expect(within(count()!).getByRole("status")).toHaveTextContent("3 selected");
      expect(within(count()!).getByRole("button", { name: "Remove" })).toBeEnabled();

      // Again, and it is let go.
      fireEvent.click(other, { ctrlKey: true });
      expect(isSelected(other)).toBe(false);
      expect(within(count()!).getByRole("status")).toHaveTextContent("2 selected");

      await act(async () => undefined);
      expect(window.location.hash).toBe("#/inbox");
      expect(called(invoke, "assist:resume")).toEqual([]);
    });

    it("takes the range from the last row clicked with Shift-click, within the same list", async () => {
      const invoke = open("/chat", bridge({ "assist:list": LISTED }));
      await within(await nav()).findByRole("button", { name: "Question 1" });

      fireEvent.click(earlierRow("Question 1"), { ctrlKey: true });
      expect(fireEvent.click(earlierRow("Question 4"), { shiftKey: true })).toBe(false);
      expect(["Question 0", "Question 1", "Question 2", "Question 3", "Question 4", "Question 5"].map((title) => isSelected(earlierRow(title)))).toEqual([
        false,
        true,
        true,
        true,
        true,
        false,
      ]);
      // Upwards from the same row too.
      fireEvent.click(earlierRow("Question 0"), { shiftKey: true });
      expect(isSelected(earlierRow("Question 0"))).toBe(true);
      expect(within(count()!).getByRole("status")).toHaveTextContent("5 selected");

      // A range never crosses into the open chats: the row clicked is all it takes.
      fireEvent.click(within(rail()).getByRole("button", { name: "Rework the release pipeline." }), { shiftKey: true });
      expect(within(count()!).getByRole("status")).toHaveTextContent("6 selected");
      expect(isSelected(within(rail()).getByRole("link", { name: "What does Hold do?" }))).toBe(false);
      expect(called(invoke, "assist:resume")).toEqual([]);
    });

    it("lets the selection go on a plain click, which opens the chat as it always has", async () => {
      const invoke = open("/inbox", bridge({ "assist:list": LISTED, "assist:resume": { conversation: { ...conversation(), id: "t3" }, problem: null } }));
      await within(await nav()).findByRole("button", { name: "Question 1" });
      fireEvent.click(earlierRow("Question 1"), { ctrlKey: true });
      expect(count()).toBeInTheDocument();

      fireEvent.click(earlierRow("Question 3"));

      expect(count()).not.toBeInTheDocument();
      expect(isSelected(earlierRow("Question 1"))).toBe(false);
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:resume", { conversationId: "t3" }));
    });

    it("puts a checkbox on every row in select mode, where a click or Space toggles and nothing drags, and Cancel or Escape leaves it", async () => {
      const invoke = open("/inbox", bridge({ "assist:list": LISTED }));
      await within(await nav()).findByRole("button", { name: "Question 1" });
      expect(within(rail()).queryAllByRole("checkbox")).toEqual([]);

      fireEvent.click(within(rail()).getByRole("button", { name: "Select" }));
      expect(within(rail()).getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "true");
      // Two open chats and the six earlier ones drawn.
      expect(within(rail()).getAllByRole("checkbox")).toHaveLength(8);
      expect(within(count()!).getByRole("status")).toHaveTextContent("0 selected");
      expect(within(count()!).getByRole("button", { name: "Remove" })).toBeDisabled();
      // Rows are chosen here, not dragged.
      const openItems = within(within(rail()).getByRole("list", { name: "Open chats" })).getAllByRole("listitem");
      expect(openItems.map((item) => item.getAttribute("data-draggable"))).toEqual(["false", "false"]);

      // A click on a row, on the chat on show too, and Space on another.
      const shownRow = within(rail()).getByRole("link", { name: "What does Hold do?" });
      expect(fireEvent.click(shownRow)).toBe(false);
      fireEvent.click(earlierRow("Question 0"));
      const other = within(rail()).getByRole("button", { name: "Rework the release pipeline." });
      other.focus();
      expect(fireEvent.keyDown(other, { key: " " })).toBe(false);
      expect(within(rail()).getByRole("checkbox", { name: "Select “What does Hold do?”" })).toBeChecked();
      expect(within(rail()).getByRole("checkbox", { name: "Select “Rework the release pipeline.”" })).toBeChecked();
      expect(within(rail()).getByRole("checkbox", { name: "Select “Question 0”" })).toBeChecked();
      expect(within(count()!).getByRole("status")).toHaveTextContent("3 selected");
      // The box itself toggles too.
      fireEvent.click(within(rail()).getByRole("checkbox", { name: "Select “Question 0”" }));
      expect(within(count()!).getByRole("status")).toHaveTextContent("2 selected");

      fireEvent.keyDown(other, { key: " " });
      expect(within(count()!).getByRole("status")).toHaveTextContent("1 selected");

      fireEvent.click(within(count()!).getByRole("button", { name: "Cancel" }));
      expect(count()).not.toBeInTheDocument();
      expect(within(rail()).queryAllByRole("checkbox")).toEqual([]);
      expect(openItems.map((item) => item.getAttribute("data-draggable"))).toEqual(["true", "true"]);

      fireEvent.click(within(rail()).getByRole("button", { name: "Select" }));
      fireEvent.click(earlierRow("Question 2"));
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(count()).not.toBeInTheDocument();
      expect(within(rail()).queryAllByRole("checkbox")).toEqual([]);
      expect(isSelected(earlierRow("Question 2"))).toBe(false);

      // Escape lets a selection made by modifier clicks go as well.
      fireEvent.click(earlierRow("Question 2"), { ctrlKey: true });
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(count()).not.toBeInTheDocument();

      expect(window.location.hash).toBe("#/inbox");
      expect(called(invoke, "assist:resume")).toEqual([]);
      expect(called(invoke, "assist:reorder")).toEqual([]);
    });

    it("selects every earlier chat with its Select all, the ones behind Show all too, and lets them go on a second press", async () => {
      open("/chat", bridge({ "assist:list": LISTED }));
      await within(await nav()).findByRole("button", { name: "Question 1" });
      fireEvent.click(within(rail()).getByRole("button", { name: "Select" }));

      const earlierAll = within(rail()).getByRole("button", { name: "Select all earlier chats" });
      fireEvent.click(earlierAll);
      expect(earlierAll).toHaveAttribute("aria-pressed", "true");
      expect(within(count()!).getByRole("status")).toHaveTextContent("9 selected");
      fireEvent.click(within(rail()).getByRole("button", { name: "Show all 9" }));
      expect(within(rail()).getByRole("checkbox", { name: "Select “Question 8”" })).toBeChecked();
      expect(within(rail()).getByRole("checkbox", { name: "Select “Rework the release pipeline.”" })).not.toBeChecked();

      const openAll = within(rail()).getByRole("button", { name: "Select all open chats" });
      fireEvent.click(openAll);
      expect(within(count()!).getByRole("status")).toHaveTextContent("11 selected");

      fireEvent.click(earlierAll);
      expect(within(count()!).getByRole("status")).toHaveTextContent("2 selected");
      expect(within(rail()).getByRole("checkbox", { name: "Select “Question 8”" })).not.toBeChecked();
      fireEvent.click(openAll);
      expect(within(count()!).getByRole("status")).toHaveTextContent("0 selected");
    });

    it("offers Remove N chats on a selected row's menu, and plain Remove on any other", async () => {
      open("/chat", bridge({ "assist:list": LISTED }));
      await within(await nav()).findByRole("button", { name: "Question 1" });
      fireEvent.click(earlierRow("Question 1"), { ctrlKey: true });
      fireEvent.click(earlierRow("Question 2"), { ctrlKey: true });

      fireEvent.contextMenu(earlierRow("Question 2"), { clientX: 40, clientY: 120 });
      expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual(["Remove 2 chats"]);
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      // Escape closed the menu, and left the selection alone.
      expect(within(count()!).getByRole("status")).toHaveTextContent("2 selected");

      fireEvent.contextMenu(earlierRow("Question 3"), { clientX: 40, clientY: 120 });
      expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual(["Remove"]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
      expect(screen.getByRole("dialog", { name: "Remove “Question 3”?" })).toBeInTheDocument();
    });

    it("warns once for them all, naming the first several and how many more, and removes nothing on Keep chats", async () => {
      const invoke = open("/chat", bridge({ "assist:list": LISTED }));
      await within(await nav()).findByRole("button", { name: "Question 1" });
      fireEvent.click(within(rail()).getByRole("button", { name: "Select" }));
      fireEvent.click(within(rail()).getByRole("button", { name: "Select all earlier chats" }));

      fireEvent.click(within(count()!).getByRole("button", { name: "Remove" }));
      let dialog = screen.getByRole("dialog", { name: "Remove 9 chats?" });
      expect(within(within(dialog).getByRole("list", { name: "Chats to remove" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
        "“Question 0”",
        "“Question 1”",
        "“Question 2”",
        "“Question 3”",
        "“Question 4”",
        "and 4 more",
      ]);
      expect(dialog).toHaveTextContent("These chats will be permanently removed and cannot be recovered.");
      expect(dialog).toHaveTextContent("Their messages, run history, queued requests and attachments go with them.");
      // Only earlier chats: nothing running, and the chat on show stays.
      expect(dialog).not.toHaveTextContent("cancelled");
      expect(dialog).not.toHaveTextContent("new, empty chat");
      expect(within(dialog).getByRole("button", { name: "Keep chats" })).toHaveFocus();
      expect(within(dialog).getByRole("button", { name: "Remove 9 chats" })).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "Keep chats" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // An open chat that is not on show: its turn is cancelled, and nobody is moved.
      fireEvent.click(within(rail()).getByRole("button", { name: "Select all earlier chats" }));
      fireEvent.click(within(rail()).getByRole("button", { name: "Rework the release pipeline." }));
      fireEvent.click(earlierRow("Question 0"));
      fireEvent.click(within(count()!).getByRole("button", { name: "Remove" }));
      dialog = screen.getByRole("dialog", { name: "Remove 2 chats?" });
      expect(dialog).toHaveTextContent("Anything they are running is cancelled.");
      expect(dialog).not.toHaveTextContent("new, empty chat");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      // Escape closed the warning, and left the selection where it was.
      expect(within(count()!).getByRole("status")).toHaveTextContent("2 selected");

      // The chat on show: you are left in a new, empty one.
      fireEvent.click(within(rail()).getByRole("link", { name: "What does Hold do?" }));
      fireEvent.click(within(count()!).getByRole("button", { name: "Remove" }));
      expect(screen.getByRole("dialog", { name: "Remove 3 chats?" })).toHaveTextContent("Anything they are running is cancelled. You are left in a new, empty chat.");

      expect(called(invoke, "assist:removeMany")).toEqual([]);
      expect(called(invoke, "assist:remove")).toEqual([]);
    });

    it("removes them all with one call, and leaves the person in the one new empty chat when the chat on show went", async () => {
      const fresh = { ...conversation(), id: "fresh", key: "ASK-9" };
      let removed = false;
      const base = bridge();
      const invoke = open(
        "/inbox",
        vi.fn(async (channel: string, payload?: unknown) => {
          if (channel === "assist:list") return { ok: true, data: removed ? { conversations: [thread("fresh", "Assistant", true), ...EARLIER.slice(2)] } : LISTED };
          if (channel === "assist:removeMany") {
            removed = true;
            return { ok: true, data: { removed: ["b", "a", "t0", "t1"], refused: [], conversation: fresh } };
          }
          return base(channel, payload);
        }) as unknown as ReturnType<typeof bridge>,
      );
      await within(await nav()).findByRole("button", { name: "Question 1" });
      fireEvent.click(within(rail()).getByRole("button", { name: "Select" }));
      fireEvent.click(within(rail()).getByRole("button", { name: "Select all open chats" }));
      fireEvent.click(earlierRow("Question 0"));
      fireEvent.click(earlierRow("Question 1"));
      fireEvent.contextMenu(earlierRow("Question 1"), { clientX: 40, clientY: 120 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove 4 chats" }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "Remove 4 chats?" })).getByRole("button", { name: "Remove 4 chats" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(called(invoke, "assist:removeMany")).toEqual([["assist:removeMany", { conversationIds: ["b", "a", "t0", "t1"] }]]);
      expect(called(invoke, "assist:remove")).toEqual([]);
      await waitFor(() => expect(window.location.hash).toBe("#/chat"));
      expect(await within(rail()).findByRole("link", { name: "Assistant" })).toBeInTheDocument();
      await waitFor(() => expect(within(rail()).queryByRole("button", { name: "Question 0" })).not.toBeInTheDocument());
      expect(within(rail()).queryByRole("button", { name: "Rework the release pipeline." })).not.toBeInTheDocument();
      // Done with: no selection, and out of select mode.
      expect(count()).not.toBeInTheDocument();
      expect(within(rail()).queryAllByRole("checkbox")).toEqual([]);
    });

    it("keeps the warning open naming the chats that were refused, and lets the rest go", async () => {
      let removed = false;
      const base = bridge();
      const problem = "That is not one of your conversations with the assistant. It may already have been removed.";
      open(
        "/chat",
        vi.fn(async (channel: string, payload?: unknown) => {
          if (channel === "assist:list") return { ok: true, data: removed ? { conversations: [...OPEN, ...EARLIER.slice(1)] } : LISTED };
          if (channel === "assist:removeMany") {
            removed = true;
            return { ok: true, data: { removed: ["t0"], refused: [{ conversationId: "t1", problem }], conversation: null } };
          }
          return base(channel, payload);
        }) as unknown as ReturnType<typeof bridge>,
      );
      await within(await nav()).findByRole("button", { name: "Question 1" });
      fireEvent.click(earlierRow("Question 0"), { ctrlKey: true });
      fireEvent.click(earlierRow("Question 1"), { ctrlKey: true });
      fireEvent.click(within(count()!).getByRole("button", { name: "Remove" }));
      const dialog = screen.getByRole("dialog", { name: "Remove 2 chats?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove 2 chats" }));

      expect(await within(dialog).findByRole("alert")).toHaveTextContent(`“Question 1” was not removed. ${problem}`);
      expect(screen.getByRole("dialog", { name: "Remove 1 chat?" })).toBeInTheDocument();
      expect(within(dialog).getByRole("alert")).not.toHaveTextContent("Question 0");
      await waitFor(() => expect(within(rail()).queryByRole("button", { name: "Question 0" })).not.toBeInTheDocument());
      expect(within(count()!).getByRole("status")).toHaveTextContent("1 selected");
    });
  });

  it("follows a desktop notification once, from the home where no screen's shell is mounted", async () => {
    const listeners: ((payload: { to: string }) => void)[] = [];
    window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: { to: string }) => void) => {
      if (channel === "navigate") listeners.push(callback);
      return () => {};
    }) as never;
    open("/chat");

    await screen.findByRole("region", { name: "Conversation" });
    expect(listeners).toHaveLength(1);
    act(() => listeners[0]?.({ to: "/settings" }));
    await waitFor(() => expect(window.location.hash).toBe("#/settings"));
  });

  it("offers no other layout behind the gear (EO-529)", async () => {
    open("/chat");

    fireEvent.click(within(await screen.findByRole("navigation", { name: "Main" })).getByRole("button", { name: "More places" }));
    expect(screen.getByRole("menuitem", { name: "Colours" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /layout/i })).not.toBeInTheDocument();
  });
});

describe("Settings → Colours, where the layout choice was", () => {
  it("offers colour themes and no layout to choose (EO-529)", async () => {
    open("/settings");

    fireEvent.click(await screen.findByRole("button", { name: "Colours" }));
    await waitFor(() => expect(window.location.hash).toBe("#/settings?section=layout"));
    expect(await screen.findByRole("group", { name: "Colour themes" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Layout" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});

describe("Settings in the chat layout", () => {
  it("keeps the open section in the address, so links and the tab come back to it", async () => {
    open("/settings?section=layout");
    const sections = await screen.findByRole("navigation", { name: "Settings sections" });

    fireEvent.click(within(sections).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(window.location.hash).toBe("#/settings?section=archive"));
    expect(within(sections).getByRole("button", { name: "Archive" })).toHaveAttribute("aria-current", "true");

    // The gear's "Colours" names a section while Settings is already open on another.
    await morePlace("Colours");
    expect(await screen.findByRole("group", { name: "Colour themes" })).toBeInTheDocument();

    fireEvent.click(within(sections).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(window.location.hash).toBe("#/settings?section=archive"));
    window.location.hash = "#/pipelines/p-report";
    await screen.findByRole("navigation", { name: "Pipeline views" });
    fireEvent.click(within(screen.getByRole("tablist", { name: "Open views" })).getByRole("tab", { name: /Settings/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/settings?section=archive"));
    expect(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Archive" })).toHaveAttribute("aria-current", "true");
  });
});

describe("the chat layout's colours", () => {
  it("paints the chosen theme over the window, and takes it away with the window", async () => {
    setThemeChoice({ kind: "preset", id: "nord" });
    open("/chat");
    await screen.findByRole("region", { name: "Conversation" });
    expect(rootColour("--color-canvas")).toBe("#2e3440");
    expect(rootColour("--color-accent")).toBe("#88c0d0");
    expect(rootColour("--chat-deep")).toBe("#272c36");

    cleanup();
    expect(rootColour("--color-canvas")).toBe("");
  });

  it("offers presets and a custom pick in Settings, applied the moment they are chosen", async () => {
    open("/settings?section=layout");

    const themes = await screen.findByRole("group", { name: "Colour themes" });
    // Claude unless somebody chose otherwise.
    expect(within(themes).getByRole("button", { name: /Claude/ })).toHaveAttribute("aria-pressed", "true");
    expect(rootColour("--color-canvas")).toBe("#262624");
    fireEvent.click(within(themes).getByRole("button", { name: /Tokyo Night/ }));
    await waitFor(() => expect(rootColour("--color-canvas")).toBe("#1a1b26"));
    expect(within(themes).getByRole("button", { name: /Tokyo Night/ })).toHaveAttribute("aria-pressed", "true");

    // A custom accent keeps the ground's hue and strength it was picked over.
    fireEvent.input(screen.getByLabelText("Accent"), { target: { value: "#d946ef" } });
    await waitFor(() => expect(within(themes).getByRole("button", { name: /Custom/ })).toHaveAttribute("aria-pressed", "true"));
    expect(rootColour("--color-canvas")).toMatch(/^oklch\(21% 0\.0[23]\d* 28\d/);
    expect(rootColour("--color-accent")).toMatch(/^oklch\(55% 0\.2\d* 32\d/);
    expect(JSON.parse(window.localStorage.getItem(THEME_STORAGE_KEY)!)).toMatchObject({ kind: "custom" });

    fireEvent.click(screen.getByRole("button", { name: "Reset to Claude" }));
    await waitFor(() => expect(rootColour("--color-canvas")).toBe("#262624"));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("warns when a custom accent could be read as a status", async () => {
    open("/settings?section=layout");

    fireEvent.input(await screen.findByLabelText("Accent"), { target: { value: "#22c55e" } });
    expect(await screen.findByRole("status")).toHaveTextContent(/close to the colour that means running/);
  });

  it("never warns about a preset's accent that came along with a picked background", async () => {
    open("/settings?section=layout");

    fireEvent.input(await screen.findByLabelText("Background"), { target: { value: "#1e3a5f" } });
    const themes = screen.getByRole("group", { name: "Colour themes" });
    await waitFor(() => expect(within(themes).getByRole("button", { name: /Custom/ })).toHaveAttribute("aria-pressed", "true"));
    // Claude's clay, unchanged: the default, not a mistake.
    expect(rootColour("--color-accent")).toMatch(/^oklch\(55% 0\.13\d* 39\.2\)$/);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps a custom theme a press away after trying a preset", async () => {
    open("/settings?section=layout");

    fireEvent.input(await screen.findByLabelText("Accent"), { target: { value: "#0ea5e9" } });
    const themes = screen.getByRole("group", { name: "Colour themes" });
    await waitFor(() => expect(within(themes).getByRole("button", { name: /Custom/ })).toHaveAttribute("aria-pressed", "true"));
    const custom = rootColour("--color-accent");

    fireEvent.click(within(themes).getByRole("button", { name: /Linear/ }));
    await waitFor(() => expect(within(themes).getByRole("button", { name: /Custom/ })).toHaveAttribute("aria-pressed", "false"));
    fireEvent.click(within(themes).getByRole("button", { name: /Custom/ }));
    await waitFor(() => expect(rootColour("--color-accent")).toBe(custom));
  });

  it("is reached from behind the rail's gear", async () => {
    open("/chat");

    await morePlace("Colours");
    expect(await screen.findByRole("group", { name: "Colour themes" })).toBeInTheDocument();
    // A preset is never second-guessed: Claude's clay is the default, not a mistake.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

/**
 * The main window's own title bar (EO-668). The native one is hidden, so
 * the top row is what drags the window, leaves room for the controls the
 * system draws over it, and tells the main process what colour to draw
 * them in. What CSS does with `app-drag` and `env(titlebar-area-*)` is
 * Chromium's, and not something jsdom can show; what is held here is that
 * the row asks for it, where, and when.
 */
describe("the main window's title bar", () => {
  type Listener = (payload: unknown) => void;

  function pushes() {
    const listeners = new Map<string, Listener[]>();
    window.eo.ipc.subscribe = vi.fn((channel: string, callback: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((listener) => listener !== callback));
    }) as never;
    return (channel: string, payload: unknown) => act(() => (listeners.get(channel) ?? []).forEach((listener) => listener(payload)));
  }

  const coloured = (invoke: ReturnType<typeof bridge>) => invoke.mock.calls.filter(([name]) => name === "window:titleBar").map(([, payload]) => payload);
  const dragging = (element: Element | null) => element?.classList.contains("app-drag") ?? false;
  /** The rail's top inset — where macOS's traffic lights sit — or null where none is drawn. */
  const railInset = () => {
    const first = rail().firstElementChild;
    return first !== null && dragging(first) && first.childElementCount === 0 ? first : null;
  };
  const overviewStrip = () => screen.queryByRole("region", { name: "Overview" })?.previousElementSibling ?? null;

  afterEach(() => {
    cleanup();
    setBridge(undefined);
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    window.sessionStorage.removeItem("eo.serverToken");
    window.history.replaceState(null, "", "/");
  });

  it("drags the window by the top row, and leaves what is in it pressable", async () => {
    open("/pipelines/p-report");
    const conversation = await screen.findByRole("region", { name: "Conversation" });
    const tabs = (await screen.findByRole("tablist", { name: "Open views" })).parentElement;

    expect(railInset()).not.toBeNull();
    expect(dragging(screen.getByRole("button", { name: "Switch project" }).parentElement)).toBe(true);
    expect(dragging(conversation.querySelector("header"))).toBe(true);
    expect(dragging(tabs)).toBe(true);
    // Every control in those rows is a button or a tab, which the stylesheet takes out of the drag.
    for (const row of [conversation.querySelector("header")!, tabs!]) {
      for (const control of row.querySelectorAll("button")) expect(control.closest(".app-drag")).toBe(row);
    }
  });

  it("puts a strip of title bar over the overview, which has no header", async () => {
    open("/chat");
    await screen.findByRole("region", { name: "Overview" });

    expect(dragging(overviewStrip())).toBe(true);
    expect(overviewStrip()).toHaveAttribute("aria-hidden", "true");
  });

  it("colours the window controls with the theme, and again the moment it changes", async () => {
    const invoke = open("/settings?section=layout");
    const themes = await screen.findByRole("group", { name: "Colour themes" });
    // Claude's deep, which a view beside the conversation is drawn on, and its muted ink.
    await waitFor(() => expect(coloured(invoke).at(-1)).toEqual({ color: "#1f1e1d", symbolColor: "#c3c1b8" }));

    fireEvent.click(within(themes).getByRole("button", { name: /Nord/ }));

    await waitFor(() => expect(coloured(invoke).at(-1)).toEqual({ color: "#272c36", symbolColor: "#d8dee9" }));
  });

  it("colours them for what is under them: the overview, or the conversation once it is hidden", async () => {
    const invoke = open("/chat");
    await screen.findByRole("region", { name: "Overview" });
    await waitFor(() => expect(coloured(invoke).at(-1)).toEqual({ color: "#1f1e1d", symbolColor: "#c3c1b8" }));

    fireEvent.click(screen.getByRole("button", { name: "Hide the side panel" }));

    // The conversation's header is at the window's edge now, on the canvas colour.
    await waitFor(() => expect(coloured(invoke).at(-1)).toEqual({ color: "#262624", symbolColor: "#c3c1b8" }));
  });

  it("colours them for a banner while one is up, through a theme change, and for what is under it when it goes", async () => {
    const push = pushes();
    let state = "offline";
    const invoke = bridge();
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "sync:status") return { ok: true, data: { state, offlineSince: 1, queued: 0, queuedItemIds: [], problem: null } };
      return bridge()(channel);
    });
    open("/chat", invoke);
    await screen.findByRole("region", { name: "Overview" });
    await screen.findByRole("status", { name: "Offline" });

    // The banner is the top of the window's right edge, on the canvas colour, over the overview.
    await waitFor(() => expect(coloured(invoke).at(-1)).toEqual({ color: "#262624", symbolColor: "#c3c1b8" }));

    act(() => setThemeChoice({ kind: "preset", id: "nord" }));
    await waitFor(() => expect(coloured(invoke).at(-1)).toEqual({ color: "#2e3440", symbolColor: "#d8dee9" }));

    state = "online";
    push("items:changed", {});
    await waitFor(() => expect(screen.queryByRole("status", { name: "Offline" })).not.toBeInTheDocument());
    // Gone, the overview's deep is at the edge again.
    await waitFor(() => expect(coloured(invoke).at(-1)).toEqual({ color: "#272c36", symbolColor: "#d8dee9" }));
  });

  it("lets the conversation beside a canvas give way before the canvas would go under the controls", async () => {
    open("/pipelines/p-report");
    const conversation = await screen.findByRole("region", { name: "Conversation" });

    // Not shrink-0 any more: the canvas holds its minimum, and the conversation narrows to 16rem.
    expect(conversation).toHaveClass("w-[30rem]", "min-w-[16rem]", "shrink");
    expect(conversation).not.toHaveClass("shrink-0");
  });

  it("reserves nothing in full screen, and the room comes back when it leaves", async () => {
    const push = pushes();
    let fullScreen = true;
    const invoke = bridge();
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "window:state") return { ok: true, data: { fullScreen } };
      return bridge()(channel);
    });
    open("/chat", invoke);
    await screen.findByRole("region", { name: "Overview" });
    await waitFor(() => expect(railInset()).toBeNull());
    expect(dragging(overviewStrip())).toBe(false);

    fullScreen = false;
    push("window:changed", {});

    await waitFor(() => expect(railInset()).not.toBeNull());
    expect(dragging(overviewStrip())).toBe(true);
  });

  it("is not drawn in a browser tab, which has no title bar to stand in for", async () => {
    window.sessionStorage.setItem("eo.serverToken", "token-for-the-test");
    setBridge({
      machineAvailable: false,
      invoke: (channel, payload) => window.eo.ipc.invoke(channel, payload),
      subscribe: (channel, callback) => window.eo.ipc.subscribe(channel, callback),
      subscribeRefetch: () => () => {},
    });
    const invoke = open("/chat");
    await screen.findByRole("region", { name: "Overview" });

    expect(railInset()).toBeNull();
    expect(dragging(overviewStrip())).toBe(false);
    expect(coloured(invoke)).toEqual([]);
    expect(invoke.mock.calls.some(([name]) => name === "window:state")).toBe(false);
  });

  it("is not the canvas's own window's, which keeps its native frame", async () => {
    window.history.replaceState(null, "", "/?window=canvas");
    const invoke = open("/pipelines/p-report", bridge({ "canvas:state": { poppedOut: true, tabs: ["/pipelines/p-report"], active: "/pipelines/p-report" } }));
    const tabs = (await screen.findByRole("tablist", { name: "Open views" })).parentElement;

    expect(dragging(tabs)).toBe(false);
    expect(coloured(invoke)).toEqual([]);
  });
});

/**
 * The canvas in a window of its own (EO-383).
 *
 * Two renderers share nothing but the main process, so each half is a
 * case of its own: the main window, which hands the canvas over and then
 * sends every view it is asked for across; and the canvas's window,
 * which is this same app loaded with `?window=canvas` in front of its
 * hash. What passes between them is `canvas:*`, and the cases play the
 * main process's part by answering those channels and firing its pushes.
 */
describe("the canvas, popped out into its own window", () => {
  type Listener = (payload: unknown) => void;

  /** The pushes this window is listening for, so a case can be the main process sending one. */
  function pushes() {
    const listeners = new Map<string, Listener[]>();
    window.eo.ipc.subscribe = vi.fn((channel: string, callback: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
      return () => {};
    }) as never;
    return (channel: string, payload: unknown) => act(() => (listeners.get(channel) ?? []).forEach((listener) => listener(payload)));
  }

  const sent = (invoke: ReturnType<typeof bridge>, channel: string) => invoke.mock.calls.filter(([name]) => name === channel).map(([, payload]) => payload);
  const openTabs = () => within(screen.getByRole("tablist", { name: "Open views" })).getAllByRole("tab");

  /** Loads the app as the canvas's own window: the marker goes in the query, in front of the hash. */
  function asCanvasWindow() {
    window.history.replaceState(null, "", "/?window=canvas");
  }

  afterEach(() => {
    cleanup();
    setBridge(undefined);
    window.sessionStorage.removeItem("eo.serverToken");
    window.history.replaceState(null, "", "/");
  });

  it("offers Pop out immediately left of Close the canvas, on a desktop", async () => {
    open("/pipelines/p-report");

    const close = await screen.findByRole("button", { name: "Close the canvas" });
    expect(close.previousElementSibling).toBe(screen.getByRole("button", { name: "Pop out" }));
  });

  it("offers no Pop out where EO cannot open a window", async () => {
    // A browser served this renderer: the transport that has no machine.
    window.sessionStorage.setItem("eo.serverToken", "token-for-the-test");
    setBridge({
      machineAvailable: false,
      invoke: (channel, payload) => window.eo.ipc.invoke(channel, payload),
      subscribe: (channel, callback) => window.eo.ipc.subscribe(channel, callback),
      subscribeRefetch: () => () => {},
    });
    const invoke = open("/pipelines/p-report");

    await screen.findByRole("button", { name: "Close the canvas" });
    expect(screen.queryByRole("button", { name: "Pop out" })).not.toBeInTheDocument();
    // Nor does it ask about a window it could never have.
    expect(sent(invoke, "canvas:state")).toEqual([]);
  });

  it("hands its tabs to the new window, and leaves the conversation the full width", async () => {
    pushes();
    const invoke = open("/pipelines/p-report", bridge({ "canvas:window": { opened: true }, "canvas:state": { poppedOut: false, tabs: [], active: null } }));
    await screen.findByRole("region", { name: "Canvas" });
    window.location.hash = "#/items/i1";
    await waitFor(() => expect(openTabs()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Pop out" }));

    await waitFor(() => expect(window.location.hash).toBe("#/chat"));
    // The same tabs, and the same one open.
    expect(sent(invoke, "canvas:window")).toEqual([{ tabs: ["/pipelines/p-report", "/items/i1"], active: "/items/i1" }]);
    expect(screen.queryByRole("region", { name: "Canvas" })).not.toBeInTheDocument();
    // The home's own columns: the conversation is not the narrow one it is beside a view.
    expect(screen.getByRole("region", { name: "Conversation" })).toHaveClass("flex-1");
    // The view it was popped out on went with it, and is not sent again.
    expect(sent(invoke, "canvas:open")).toEqual([]);
  });

  it("stays where it was when no window opened", async () => {
    const invoke = open("/pipelines/p-report", bridge({ "canvas:window": { opened: false } }));

    fireEvent.click(await screen.findByRole("button", { name: "Pop out" }));

    await waitFor(() => expect(sent(invoke, "canvas:window")).toHaveLength(1));
    expect(screen.getByRole("region", { name: "Canvas" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/pipelines/p-report");
  });

  it("opens what the chat asks for as a tab over there, and stays chat-only", async () => {
    pushes();
    const invoke = open("/chat", bridge({ "canvas:open": { opened: true }, "canvas:state": { poppedOut: true, tabs: ["/pipelines/p-report"], active: "/pipelines/p-report" } }));
    await screen.findByRole("region", { name: "Conversation" });
    await waitFor(() => expect(sent(invoke, "canvas:state")).toHaveLength(1));
    const publishedBefore = sent(invoke, "view:publish").length;

    // An item's link in a message, a board in the rail: this window is
    // taken to a view's address, whoever took it there.
    window.location.hash = "#/items/i1";

    await waitFor(() => expect(sent(invoke, "canvas:open")).toEqual([{ path: "/items/i1" }]));
    await waitFor(() => expect(window.location.hash).toBe("#/chat"));
    expect(screen.queryByRole("region", { name: "Canvas" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Conversation" })).toHaveClass("flex-1");
    // And says nothing about its own screen meanwhile: the canvas's
    // window is the one the assistant reads while it is out.
    expect(sent(invoke, "view:publish")).toHaveLength(publishedBefore);

    fireEvent.click(within(rail()).getByRole("link", { name: /Vendor invoices/ }));
    await waitFor(() => expect(sent(invoke, "canvas:open")).toHaveLength(2));
    expect(sent(invoke, "canvas:open")[1]).toEqual({ path: "/pipelines/p-invoices" });
    await waitFor(() => expect(window.location.hash).toBe("#/chat"));
  });

  it("draws the view itself when the canvas window turns out to be gone", async () => {
    pushes();
    const invoke = open("/chat", bridge({ "canvas:open": { opened: false }, "canvas:state": { poppedOut: true, tabs: [], active: null } }));
    await waitFor(() => expect(sent(invoke, "canvas:state")).toHaveLength(1));

    window.location.hash = "#/items/i1";

    expect(await screen.findByRole("region", { name: "Canvas" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe("#/items/i1"));
  });

  it("restores the tabs a pop-in hands back, with the same one open", async () => {
    const push = pushes();
    const invoke = open("/chat", bridge({ "canvas:state": { poppedOut: true, tabs: [], active: null } }));
    await waitFor(() => expect(sent(invoke, "canvas:state")).toHaveLength(1));

    push("canvas:changed", { poppedOut: false, restore: { tabs: ["/pipelines/p-report", "/items/i1", "/inbox"], active: "/items/i1" } });

    await waitFor(() => expect(window.location.hash).toBe("#/items/i1"));
    const canvas = await screen.findByRole("region", { name: "Canvas" });
    await waitFor(() => expect(openTabs()).toHaveLength(3));
    expect(openTabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(within(canvas).getByRole("tab", { name: /RPT-7/ })).toHaveAttribute("aria-selected", "true");
    // It is this window's canvas again: nothing is sent across, and it speaks for its own screen.
    expect(sent(invoke, "canvas:open")).toEqual([]);
    await waitFor(() => expect(sent(invoke, "view:publish").at(-1)).toMatchObject({ page: { route: "/items/:itemId" } }));
  });

  it("stays chat-only when the canvas window is closed rather than popped in", async () => {
    const push = pushes();
    const invoke = open("/chat", bridge({ "canvas:state": { poppedOut: true, tabs: ["/items/i1"], active: "/items/i1" } }));
    await waitFor(() => expect(sent(invoke, "canvas:state")).toHaveLength(1));

    push("canvas:changed", { poppedOut: false, restore: null });

    await screen.findByRole("region", { name: "Conversation" });
    expect(window.location.hash).toBe("#/chat");
    expect(screen.queryByRole("region", { name: "Canvas" })).not.toBeInTheDocument();
    // Views open here again from now on.
    window.location.hash = "#/inbox";
    expect(await screen.findByRole("region", { name: "Canvas" })).toBeInTheDocument();
    expect(sent(invoke, "canvas:open")).toEqual([]);
  });

  describe("its own window", () => {
    const STATE = { poppedOut: true, tabs: ["/pipelines/p-report", "/items/i1"], active: "/items/i1" };

    it("draws the canvas alone, with the tabs it was popped out with and the same one open", async () => {
      asCanvasWindow();
      const invoke = open("/items/i1", bridge({ "canvas:state": STATE }));

      await screen.findByRole("region", { name: "Canvas" });
      await waitFor(() => expect(openTabs()).toHaveLength(2));
      expect(within(screen.getByRole("tablist", { name: "Open views" })).getByRole("tab", { name: /RPT-7/ })).toHaveAttribute("aria-selected", "true");
      expect(screen.queryByRole("region", { name: "Conversation" })).not.toBeInTheDocument();
      expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
      // This is the window the assistant reads while the canvas is out.
      await waitFor(() => expect(sent(invoke, "view:publish").at(-1)).toMatchObject({ page: { route: "/items/:itemId" } }));
    });

    it("reads Pop in where the main window reads Pop out, and hands its tabs back", async () => {
      asCanvasWindow();
      const invoke = open("/items/i1", bridge({ "canvas:state": STATE }));
      await waitFor(() => expect(openTabs()).toHaveLength(2));
      window.location.hash = "#/inbox";
      await waitFor(() => expect(openTabs()).toHaveLength(3));

      expect(screen.queryByRole("button", { name: "Pop out" })).not.toBeInTheDocument();
      const popIn = screen.getByRole("button", { name: "Pop in" });
      expect(screen.getByRole("button", { name: "Close the canvas" }).previousElementSibling).toBe(popIn);
      fireEvent.click(popIn);

      await waitFor(() => expect(sent(invoke, "canvas:close")).toEqual([{ restore: { tabs: ["/pipelines/p-report", "/items/i1", "/inbox"], active: "/inbox" } }]));
    });

    it("closes the canvas, handing nothing back, from Close the canvas and from its last tab", async () => {
      asCanvasWindow();
      const invoke = open("/items/i1", bridge({ "canvas:state": { poppedOut: true, tabs: ["/items/i1"], active: "/items/i1" } }));
      await waitFor(() => expect(openTabs()).toHaveLength(1));

      fireEvent.click(screen.getByRole("button", { name: "Close the canvas" }));
      await waitFor(() => expect(sent(invoke, "canvas:close")).toEqual([{ restore: null }]));

      fireEvent.keyDown(openTabs()[0]!, { key: "Delete" });
      await waitFor(() => expect(sent(invoke, "canvas:close")).toEqual([{ restore: null }, { restore: null }]));
    });

    it("opens what the main window sends it as a tab", async () => {
      asCanvasWindow();
      const push = pushes();
      open("/items/i1", bridge({ "canvas:state": STATE }));
      await waitFor(() => expect(openTabs()).toHaveLength(2));

      push("canvas:opened", { path: "/pipelines/p-invoices" });

      await waitFor(() => expect(window.location.hash).toBe("#/pipelines/p-invoices"));
      await waitFor(() => expect(openTabs()).toHaveLength(3));
      expect(openTabs().at(-1)).toHaveAttribute("aria-selected", "true");
    });

    it("opens on what was asked for while it was still loading", async () => {
      asCanvasWindow();
      // Loaded at the item; by the time it asks, the main window has sent an inbox across.
      open("/items/i1", bridge({ "canvas:state": { poppedOut: true, tabs: ["/items/i1", "/inbox"], active: "/inbox" } }));

      await waitFor(() => expect(window.location.hash).toBe("#/inbox"));
      await waitFor(() => expect(openTabs()).toHaveLength(2));
    });
  });
});

/**
 * A turn drawn and driven the way Claude Desktop's is: its steps and the
 * words being written while it runs, Stop and Escape, the work folded
 * above a finished answer, and the actions under each message.
 */
describe("a turn in the chat layout's conversation", () => {
  const running = (liveTurn: Record<string, unknown>) => ({
    ...conversation([message({ id: "h1", authorType: "human", authorName: "You", body: "Rework the release pipeline.", status: "processing" })]),
    thinking: true,
    thinkingSince: Date.now(),
    liveTurn: { runId: "run-1", startedAt: Date.now(), steps: [], drafts: [], lastDraftId: 0, answer: "", ...liveTurn },
  });

  async function column() {
    const found = await screen.findByRole("region", { name: "Conversation" });
    await within(found).findByRole("textbox", { name: "Message the assistant" });
    return found;
  }

  it("draws the running turn's steps and what it is writing, and stops it from the box", async () => {
    const live = running({
      steps: [
        { kind: "text", seq: 0, text: "Reading the pipeline first." },
        { kind: "tool", seq: 1, callId: "c1", name: "mcp__eo_admin__pipeline_get", label: "eo_admin · pipeline_get", input: null, ok: null, output: null },
      ],
      drafts: [{ id: 1, stream: "text", text: '{"outcome":{"message":"It has three' }],
      lastDraftId: 1,
    });
    const invoke = open("/chat", bridge({ "assist:open": { conversation: live }, "assist:stop": { stopped: true, conversation: conversation() } }));
    const conversationColumn = await column();

    const turn = await within(conversationColumn).findByRole("article", { name: "Live agent response" });
    expect(within(turn).getByText("Reading the pipeline first.")).toBeInTheDocument();
    expect(within(turn).getByText("eo_admin · pipeline_get")).toBeInTheDocument();
    expect(within(turn).getByText("It has three")).toBeInTheDocument();

    fireEvent.click(within(conversationColumn).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:stop", { conversationId: conversation().id }));
  });

  it("stops on Escape in the box", async () => {
    const invoke = open("/chat", bridge({ "assist:open": { conversation: running({}) }, "assist:stop": { stopped: true, conversation: conversation() } }));
    const conversationColumn = await column();
    await within(conversationColumn).findByRole("article", { name: "Live agent response" });
    fireEvent.keyDown(within(conversationColumn).getByRole("textbox", { name: "Message the assistant" }), { key: "Escape" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:stop", { conversationId: conversation().id }));
  });

  it("folds a finished turn's work above its answer, and opens it to the steps", async () => {
    const answered = conversation([
      message({ id: "h1", authorType: "human", authorName: "You", body: "What is waiting?" }),
      message({ id: "a1", body: "Two approvals.", runId: "run-1", turn: { runId: "run-1", durationMs: 75_000, toolCalls: 3, filesEdited: 0, reasoned: true } }),
    ]);
    const invoke = open("/chat", bridge({ "assist:open": { conversation: answered }, "runs:steps": { steps: [{ kind: "reasoning", seq: 0, text: "Check the inbox." }] } }));
    const conversationColumn = await column();

    const fold = await within(conversationColumn).findByRole("button", { name: "Worked for 1m 15s · 3 tool calls" });
    fireEvent.click(fold);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("runs:steps", { runId: "run-1" }));
    expect(await within(conversationColumn).findByRole("button", { name: "Thought" })).toBeInTheDocument();
  });

  it("forks from a message and retries the last one from the actions under it", async () => {
    const answered = conversation([
      message({ id: "h1", authorType: "human", authorName: "You", body: "What is waiting?" }),
      message({ id: "a1", body: "Two approvals.", runId: "run-1" }),
    ]);
    const invoke = open("/chat", bridge({ "assist:open": { conversation: answered }, "assist:fork": { conversation: conversation(), problem: null }, "assist:send": { conversation: answered, delivery: null } }));
    const conversationColumn = await column();
    await within(conversationColumn).findByText("Two approvals.");

    const forks = within(conversationColumn).getAllByRole("button", { name: "Fork from here" });
    fireEvent.click(forks.at(-1)!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:fork", { conversationId: conversation().id, messageId: "a1" }));

    fireEvent.click(within(conversationColumn).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:send", expect.objectContaining({ body: "What is waiting?", interrupt: false })));
  });

  it("keeps a stopped turn's work opened above the stop, with Retry under it, and offers no Retry while something newer waits", async () => {
    const stopped = conversation([
      message({ id: "h1", authorType: "human", authorName: "You", body: "Write the essay.", createdAt: 1 }),
      message({ id: "e1", authorType: "engine", authorName: "EO", body: "Turn stopped.", runId: "run-1", createdAt: 2, turn: { runId: "run-1", durationMs: 4_000, toolCalls: 0, filesEdited: 0, reasoned: true } }),
    ]);
    const invoke = open("/chat", bridge({ "assist:open": { conversation: stopped }, "runs:steps": { steps: [{ kind: "text", seq: 0, text: "Timekeeping began with" }] }, "assist:send": { conversation: stopped, delivery: null } }));
    const conversationColumn = await column();
    expect(await within(conversationColumn).findByText("Timekeeping began with")).toBeInTheDocument();
    expect(within(conversationColumn).getByText("Turn stopped.")).toBeInTheDocument();
    fireEvent.click(within(conversationColumn).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:send", expect.objectContaining({ body: "Write the essay." })));
  });

  it("offers no Retry while a newer message waits for its turn", async () => {
    const waiting = conversation([
      message({ id: "h1", authorType: "human", authorName: "You", body: "First.", createdAt: 1 }),
      message({ id: "a1", body: "Done.", runId: "run-1", createdAt: 2 }),
      message({ id: "h2", authorType: "human", authorName: "You", body: "Second.", createdAt: 3, status: "queued" }),
    ]);
    open("/chat", bridge({ "assist:open": { conversation: waiting } }));
    const conversationColumn = await column();
    await within(conversationColumn).findByText("Done.");
    expect(within(conversationColumn).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("edits a message by branching from just before it, with the words back in the box", async () => {
    const said = conversation([
      message({ id: "h1", authorType: "human", authorName: "You", body: "What is waiting?", createdAt: 1 }),
      message({ id: "a1", body: "Two approvals.", runId: "run-1", createdAt: 2 }),
      message({ id: "h2", authorType: "human", authorName: "You", body: "Approve the first.", createdAt: 3 }),
    ]);
    const invoke = open("/chat", bridge({ "assist:open": { conversation: said }, "assist:fork": { conversation: conversation(), problem: null }, "assist:new": { conversation: conversation() } }));
    const conversationColumn = await column();
    await within(conversationColumn).findByText("Approve the first.");

    const edits = within(conversationColumn).getAllByRole("button", { name: "Edit" });
    fireEvent.click(edits[1]!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:fork", { conversationId: conversation().id, messageId: "a1" }));
    await waitFor(() => expect(within(conversationColumn).getByRole("textbox", { name: "Message the assistant" })).toHaveValue("Approve the first."));

    // The first message has nothing before it: its edit starts an empty chat.
    fireEvent.click(edits[0]!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:new", undefined));
  });

  it("carries a long chat's newest stretch and reads older pages back on demand", async () => {
    const newest = { ...conversation(Array.from({ length: 3 }, (_, index) => message({ id: `n${index}`, body: `Newer ${index}`, createdAt: 100 + index }))), earlier: 2 };
    const invoke = open(
      "/chat",
      bridge({ "assist:open": { conversation: newest }, "assist:earlier": { messages: [message({ id: "o0", body: "Older 0", createdAt: 1 }), message({ id: "o1", body: "Older 1", createdAt: 2 })], earlier: 0 } }),
    );
    const conversationColumn = await column();
    await within(conversationColumn).findByText("Newer 2");
    fireEvent.click(within(conversationColumn).getByRole("button", { name: "Show earlier messages (2)" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:earlier", { conversationId: conversation().id, before: "n0", limit: 50 }));
    expect(await within(conversationColumn).findByText("Older 0")).toBeInTheDocument();
    expect(within(conversationColumn).queryByRole("button", { name: /Show earlier messages/ })).toBeNull();
  });

  it("checks a model named with /model against the backend's list, saving its id or saying what there is", async () => {
    const configurable = { ...conversation(), settings: { ...conversation().settings, reasoningEfforts: ["low", "high"], showReasoning: true, configurable: true } };
    const models = {
      capabilities: { provider: "claude", models: [], modelsAreLive: true, reasoningEfforts: ["low", "high"] },
      models: [{ value: "claude-sonnet-5-5", label: "Sonnet 5.5", supportsEffort: true, effortLevels: ["low", "high"] }],
      problem: null,
    };
    const invoke = open("/chat", bridge({ "assist:open": { conversation: configurable }, "providers:capabilities": models, "assist:settings": { settings: configurable.settings, conversation: configurable } }));
    const conversationColumn = await column();
    const box = within(conversationColumn).getByRole("textbox", { name: "Message the assistant" });

    fireEvent.change(box, { target: { value: "/model sonnet 5.5", selectionStart: 17 } });
    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:settings", { conversationId: conversation().id, model: "claude-sonnet-5-5" }));

    fireEvent.change(box, { target: { value: "/model sonet", selectionStart: 12 } });
    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await within(conversationColumn).findByRole("alert")).toHaveTextContent("There is no model called “sonet”. This backend offers: claude-sonnet-5-5.");
    expect(box).toHaveValue("/model sonet");
  });

  it("takes back a message waiting for the next turn", async () => {
    const waiting = conversation([message({ id: "h1", authorType: "human", authorName: "You", body: "And the hotfix board.", status: "queued", createdAt: 1 })]);
    const invoke = open("/chat", bridge({ "assist:open": { conversation: waiting }, "assist:withdraw": { withdrawn: true, conversation: conversation([message({ id: "h1", authorType: "human", authorName: "You", body: "And the hotfix board.", createdAt: 1 })]) } }));
    const conversationColumn = await column();
    fireEvent.click(await within(conversationColumn).findByRole("button", { name: "Take back this message" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:withdraw", { conversationId: conversation().id, messageId: "h1" }));
    expect(await within(conversationColumn).findByText("Taken back: the assistant will not answer that message.")).toBeInTheDocument();
  });

  it("warms the backend when somebody starts typing in a chat with nothing running, and not during a turn", async () => {
    const idle = conversation([message({ id: "a1", body: "Hello.", createdAt: 1 })]);
    const invoke = open("/chat", bridge({ "assist:open": { conversation: idle }, "assist:prewarm": { warming: true } }));
    const conversationColumn = await column();
    await within(conversationColumn).findByText("Hello.");
    fireEvent.change(within(conversationColumn).getByRole("textbox", { name: "Message the assistant" }), { target: { value: "W", selectionStart: 1 } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:prewarm", { conversationId: conversation().id }));
  });

  it("does not warm anything while a turn runs", async () => {
    const busy = { ...conversation(), thinking: true, thinkingSince: Date.now(), liveTurn: { runId: "r", startedAt: Date.now(), steps: [], drafts: [], lastDraftId: 0, answer: "" } };
    const invoke = open("/chat", bridge({ "assist:open": { conversation: busy } }));
    const conversationColumn = await column();
    await within(conversationColumn).findByRole("article", { name: "Live agent response" });
    fireEvent.change(within(conversationColumn).getByRole("textbox", { name: "Message the assistant" }), { target: { value: "W", selectionStart: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(invoke.mock.calls.some(([channel]) => channel === "assist:prewarm")).toBe(false);
  });

  it("sends a command followed by words as the message it is", async () => {
    const invoke = open("/chat", bridge({ "assist:send": { conversation: conversation(), delivery: null } }));
    const box = within(await column()).getByRole("textbox", { name: "Message the assistant" });
    fireEvent.change(box, { target: { value: "/clear up the naming first", selectionStart: 26 } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:send", expect.objectContaining({ body: "/clear up the naming first" })));
    expect(invoke.mock.calls.some(([channel]) => channel === "assist:clear")).toBe(false);
  });

  it("starts a new chat from /new rather than sending it", async () => {
    const invoke = open("/chat", bridge({ "assist:new": { conversation: conversation() } }));
    const box = within(await column()).getByRole("textbox", { name: "Message the assistant" });
    fireEvent.change(box, { target: { value: "/new", selectionStart: 4 } });
    // The first Enter takes the suggestion, as in Claude Desktop; the second runs it.
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(box).toHaveValue("/new "));
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:new", undefined));
    expect(invoke.mock.calls.some(([channel]) => channel === "assist:send")).toBe(false);
  });

  it("says a sent message is starting before its turn has begun", async () => {
    const waiting = conversation([message({ id: "h1", authorType: "human", authorName: "You", body: "Go.", status: "queued", createdAt: Date.now() })]);
    open("/chat", bridge({ "assist:open": { conversation: waiting } }));
    expect(await within(await column()).findByText("Starting")).toBeInTheDocument();
  });
});

describe("what each chat is doing, in the rail", () => {
  it("marks a chat with a turn running and one waiting on you, and leaves an idle one plain", async () => {
    const row = (id: string, title: string, state: string, shown = false) => ({ id, key: `ASK-${id}`, title, startedAt: 1, lastActivityAt: 2, live: true, shown, state });
    open(
      "/chat",
      bridge({
        "assist:list": {
          conversations: [row("a", "Rework the release pipeline.", "working", true), row("b", "Which board?", "waiting"), row("c", "What does Hold do?", "idle")],
        },
      }),
    );
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const openOnes = await within(nav).findByRole("list", { name: "Open chats" });
    await within(openOnes).findByText("Which board?");
    expect(within(openOnes).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Rework the release pipeline.Working",
      "Which board?Waiting on you",
      "What does Hold do?",
    ]);
  });
});

/**
 * A write's own answer, drawn as it arrives (EO-548).
 *
 * `assist:open` answers once and then never again, so whatever the screen
 * shows after a press is what the press answered with: the room is
 * re-read all the same — that is the backstop, and each case checks it
 * was asked for — but nothing on screen may be waiting for it.
 */
describe("what a press in the conversation answers with, drawn without reading the room again", () => {
  function openedOnce(first: unknown, overrides: Record<string, unknown>) {
    const base = bridge(overrides);
    let opened = false;
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "assist:open") {
        if (opened) return new Promise<never>(() => undefined);
        opened = true;
        return { ok: true, data: { conversation: first } };
      }
      return base(channel, payload);
    });
    const opens = () => invoke.mock.calls.filter(([channel]) => channel === "assist:open").length;
    return { invoke, opens };
  }

  it("closes a question card on the last answer as soon as assist:answer answers", async () => {
    const question = message({ id: "q1", kind: "question", body: "Which cadence?", runId: "run-1", options: ["Weekly", "Monthly"], canAnswer: true, createdAt: 1 });
    const answered = conversation([
      { ...question, canAnswer: false },
      message({ id: "h1", authorType: "human", authorName: "You", body: "Weekly", parentId: "q1", createdAt: 2 }),
    ]);
    const { invoke, opens } = openedOnce(conversation([question]), { "assist:answer": { answered: 1, problem: null, conversation: answered } });
    open("/chat", invoke);

    const card = await screen.findByRole("group", { name: "Questions from the product owner" });
    fireEvent.click(within(card).getByRole("button", { name: "Weekly" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:answer", { conversationId: conversation().id, answers: [{ questionId: "q1", answer: "Weekly" }] }));
    expect(await screen.findByLabelText("Questions you answered")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Questions from the product owner" })).not.toBeInTheDocument();
    // Re-read all the same, and still unanswered: the card closed on the answer's own conversation.
    await waitFor(() => expect(opens()).toBeGreaterThan(1));
  });

  it("stops asking a question card a newer turn replaced, as soon as the refused assist:answer answers", async () => {
    const question = message({ id: "q1", kind: "question", body: "Which cadence?", runId: "run-1", options: ["Weekly", "Monthly"], canAnswer: true, createdAt: 1 });
    const newer = message({ id: "q2", kind: "question", body: "Which day of the week?", runId: "run-2", options: ["Monday", "Friday"], canAnswer: true, createdAt: 3 });
    const replaced = conversation([{ ...question, canAnswer: false }, message({ id: "a1", body: "Weekly, then.", runId: "run-2", createdAt: 2 }), newer]);
    const refusal = "Those questions have already been answered or replaced by a newer turn. Read the latest message and answer that instead.";
    const { invoke, opens } = openedOnce(conversation([question]), { "assist:answer": { answered: 0, problem: refusal, conversation: replaced } });
    open("/chat", invoke);

    const card = await screen.findByRole("group", { name: "Questions from the product owner" });
    fireEvent.click(within(card).getByRole("button", { name: "Weekly" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:answer", expect.objectContaining({ answers: [{ questionId: "q1", answer: "Weekly" }] })));
    // The live card is the newer turn's; the one answered is its record, closed.
    const live = await screen.findByRole("group", { name: "Questions from the product owner" });
    expect(await within(live).findByText("Which day of the week?")).toBeInTheDocument();
    expect(within(live).queryByRole("button", { name: "Weekly" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: "Questions from the product owner" })).toHaveLength(1);
    expect(screen.getByLabelText("Questions that closed unanswered")).toHaveTextContent("Which cadence?");
    await waitFor(() => expect(opens()).toBeGreaterThan(1));
  });

  it("does not offer Create again once assist:approve has answered", async () => {
    const PLAN = {
      container: null,
      rows: [{ kind: "new", title: "What shipped", typeLabel: "Section", acceptanceCriteria: ["It cites its source"], waitsOn: [], under: null }],
      closed: null,
    };
    const card = message({ id: "p1", kind: "decision", body: "One section.", createdAt: 2, canApprove: true, approves: "items", proposal: PLAN });
    const approved = conversation([{ ...card, canApprove: false, proposal: { ...PLAN, closed: "applied" } }]);
    let answer: (value: unknown) => void = () => undefined;
    const { invoke, opens } = openedOnce(conversation([card]), {});
    const held = vi.fn(async (channel: string, payload?: unknown) =>
      channel === "assist:approve" ? new Promise((resolve) => (answer = resolve)) : invoke(channel, payload),
    );
    open("/chat", held as never);

    const proposal = await screen.findByRole("region", { name: "Proposal" });
    fireEvent.click(within(proposal).getByRole("button", { name: /^Create / }));
    expect(await within(proposal).findByRole("button", { name: "Applying…" })).toBeDisabled();

    await act(async () => answer({ ok: true, data: { applied: true, problem: null, createdKeys: ["RPT-8"], changedKeys: [], conversation: approved } }));

    await waitFor(() => expect(within(proposal).queryByRole("button", { name: "Applying…" })).not.toBeInTheDocument());
    expect(within(proposal).queryByRole("button", { name: /^Create / })).not.toBeInTheDocument();
    expect(within(proposal).getByText("Approved.")).toBeInTheDocument();
    await waitFor(() => expect(opens()).toBeGreaterThan(1));
  });

  it("spends an operation card as soon as assist:applyCard answers", async () => {
    const card = message({ id: "c1", kind: "decision", body: "**Delete** Delivery.", canApprove: true, approves: "card", card: { kind: "pipelineDelete", outcome: null } });
    const spent = conversation([{ ...card, canApprove: false, card: { kind: "pipelineDelete", outcome: { done: true, said: "Deleted Delivery." } } }]);
    const { invoke, opens } = openedOnce(conversation([card]), {
      "assist:card": { card: { kind: "pipelineDelete", pipelineId: "delivery", pipelineName: "Delivery", itemCount: 2 }, problem: null },
      "assist:applyCard": { applied: true, problem: null, said: "Deleted Delivery.", conversation: spent },
    });
    open("/chat", invoke);

    const region = await screen.findByRole("region", { name: "Delete a pipeline" });
    await within(region).findByText(/Delivery holds 2/);
    fireEvent.click(within(region).getByRole("button", { name: "Delete pipeline" }));

    expect(await within(region).findByRole("status")).toHaveTextContent("Deleted Delivery.");
    expect(within(region).queryByRole("button", { name: "Delete pipeline" })).not.toBeInTheDocument();
    await waitFor(() => expect(opens()).toBeGreaterThan(1));
  });

  it("takes Apply off a module change as soon as assist:applyChange answers", async () => {
    const card = message({
      id: "c1",
      kind: "decision",
      body: "**Proposed change to Release merge** (`release-merge`)\n\nDrops two variables.",
      canApprove: true,
      approves: "moduleChange",
      moduleChange: { moduleId: "mod-1", applied: false, describesSaved: false },
    });
    const applied = conversation([{ ...card, canApprove: false, moduleChange: { moduleId: "mod-1", applied: true, describesSaved: true } }]);
    const { invoke, opens } = openedOnce(conversation([card]), { "modules:list": { modules: [] }, "assist:applyChange": { applied: true, problem: null, conversation: applied } });
    open("/chat", invoke);

    const change = await screen.findByRole("region", { name: "Proposed module change" });
    fireEvent.click(within(change).getByRole("button", { name: "Apply change" }));

    await waitFor(() => expect(within(change).queryByRole("button", { name: /Apply change|Applying/ })).not.toBeInTheDocument());
    await waitFor(() => expect(opens()).toBeGreaterThan(1));
  });

  it("leaves the chat on show alone when a write answers about another chat", async () => {
    // The canvas approving a proposal in a chat that is no longer the one on show, as one example.
    const other = { ...conversation([message({ id: "x1", body: "From the other chat." })]), id: "019fb8c6-de92-7a41-9c33-4471f0c2b1ff", key: "ASK-2" };
    const sentOne = message({ id: "h1", authorType: "human", authorName: "You", body: "Ship the hotfix.", status: "queued", createdAt: Date.now() });
    const { invoke } = openedOnce(conversation(), { "assist:send": { conversation: other, delivery: null } });
    open("/chat", invoke);

    const column = await screen.findByRole("region", { name: "Conversation" });
    const box = await within(column).findByRole("textbox", { name: "Message the assistant" });
    fireEvent.change(box, { target: { value: sentOne.body, selectionStart: 16 } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(box).toHaveValue(""));
    expect(screen.getByLabelText("Assistant transcript")).not.toHaveTextContent("From the other chat.");
  });

  it("puts a sent message in the transcript as the box lets go of it", async () => {
    const sentOne = message({ id: "h1", authorType: "human", authorName: "You", body: "Ship the hotfix.", status: "queued", createdAt: Date.now() });
    const { invoke, opens } = openedOnce(conversation(), { "assist:send": { conversation: conversation([sentOne]), delivery: null } });
    open("/chat", invoke);

    const column = await screen.findByRole("region", { name: "Conversation" });
    const box = await within(column).findByRole("textbox", { name: "Message the assistant" });
    fireEvent.change(box, { target: { value: "Ship the hotfix.", selectionStart: 16 } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:send", expect.objectContaining({ body: "Ship the hotfix." })));
    await waitFor(() => expect(box).toHaveValue(""));
    expect(within(screen.getByLabelText("Assistant transcript")).getByText("Ship the hotfix.")).toBeInTheDocument();
    await waitFor(() => expect(opens()).toBeGreaterThan(1));
  });
});

/**
 * What a person does is on screen the moment they do it (EO-549): a sent
 * message drawn as sending with the box empty, an answered card closed as
 * sending, until the conversation holding it is drawn — and everything
 * given back if the main process refuses it.
 */
describe("a sent message and an answered card, drawn at once as pending", () => {
  const sentOne = message({ id: "h1", authorType: "human", authorName: "You", body: "Ship the hotfix.", status: "queued", createdAt: Date.now() });

  /** `assist:open` answers once, then whatever `next` says; `assist:send` waits to be answered by hand. */
  function heldSend(next: () => Promise<unknown> = () => new Promise<never>(() => undefined)) {
    const base = bridge();
    let opened = false;
    let answer: (value: unknown) => void = () => undefined;
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "assist:open") {
        if (opened) return next();
        opened = true;
        return { ok: true, data: { conversation: conversation() } };
      }
      if (channel === "assist:send") return new Promise((resolve) => (answer = resolve));
      return base(channel, payload);
    });
    return { invoke, answer: (value: unknown) => act(async () => answer(value)) };
  }

  async function send(body: string) {
    const column = await screen.findByRole("region", { name: "Conversation" });
    const box = await within(column).findByRole("textbox", { name: "Message the assistant" });
    fireEvent.change(box, { target: { value: body, selectionStart: body.length } });
    fireEvent.keyDown(box, { key: "Enter" });
    return box;
  }

  const transcript = () => screen.getByLabelText("Assistant transcript");

  it("empties the box and draws the message as sending before assist:send answers, then the stored one in its place", async () => {
    const { invoke, answer } = heldSend();
    open("/chat", invoke as never);

    const box = await send("Ship the hotfix.");

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:send", expect.objectContaining({ body: "Ship the hotfix." })));
    expect(box).toHaveValue("");
    const sending = await within(transcript()).findByLabelText("Message sending");
    expect(sending).toHaveTextContent("Ship the hotfix.");
    expect(within(sending).getByRole("status")).toHaveTextContent("Sending…");

    await answer({ ok: true, data: { conversation: conversation([sentOne]), delivery: null } });

    await waitFor(() => expect(within(transcript()).queryByLabelText("Message sending")).not.toBeInTheDocument());
    expect(within(transcript()).getAllByText("Ship the hotfix.")).toHaveLength(1);
  });

  it("takes the bubble away and gives the words back with the reason when assist:send is refused", async () => {
    const { invoke, answer } = heldSend();
    open("/chat", invoke as never);

    const box = await send("Ship the hotfix.");
    expect(await within(transcript()).findByLabelText("Message sending")).toBeInTheDocument();
    expect(box).toHaveValue("");

    await answer({ ok: false, error: { message: "That conversation is closed." } });

    await waitFor(() => expect(box).toHaveValue("Ship the hotfix."));
    expect(within(transcript()).queryByLabelText("Message sending")).not.toBeInTheDocument();
    expect(transcript()).not.toHaveTextContent("Ship the hotfix.");
    expect(screen.getByRole("alert")).toHaveTextContent("That conversation is closed.");
  });

  it("closes a question card on the last answer before assist:answer answers, and opens it again with the picks when it is refused", async () => {
    const asked = [
      message({ id: "q1", kind: "question", body: "Which cadence?", runId: "run-1", options: ["Weekly", "Monthly"], canAnswer: true, createdAt: 1 }),
      message({ id: "q2", kind: "question", body: "Which day?", runId: "run-1", options: ["Monday", "Friday"], canAnswer: true, createdAt: 2 }),
    ];
    const base = bridge();
    let opened = false;
    const answers: ((value: unknown) => void)[] = [];
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "assist:open") {
        if (opened) return new Promise<never>(() => undefined);
        opened = true;
        return { ok: true, data: { conversation: conversation(asked) } };
      }
      if (channel === "assist:answer") return new Promise((resolve) => answers.push(resolve));
      return base(channel, payload);
    });
    open("/chat", invoke as never);

    const card = await screen.findByRole("group", { name: "Questions from the product owner" });
    fireEvent.click(within(card).getByRole("button", { name: "Monthly" }));
    fireEvent.click(within(card).getByRole("button", { name: "Friday" }));

    // Closed at once, as sending, while assist:answer has not answered.
    const closed = await screen.findByLabelText("Questions you answered");
    expect(closed).toHaveAttribute("aria-busy", "true");
    expect(within(closed).getByRole("status")).toHaveTextContent("Sending your answers…");
    expect(screen.queryByRole("group", { name: "Questions from the product owner" })).not.toBeInTheDocument();

    await act(async () => answers[0]!({ ok: false, error: { message: "The database is locked." } }));

    const again = await screen.findByRole("group", { name: "Questions from the product owner" });
    expect(within(again).getByRole("alert")).toHaveTextContent("The database is locked.");
    expect(screen.queryByLabelText("Questions you answered")).not.toBeInTheDocument();
    // Both picks kept: what is sent again is what was picked.
    fireEvent.click(within(again).getByRole("button", { name: "Skip the rest" }));
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(invoke).toHaveBeenLastCalledWith("assist:answer", {
      conversationId: conversation().id,
      answers: [
        { questionId: "q1", answer: "Monthly" },
        { questionId: "q2", answer: "Friday" },
      ],
    });
  });

  it("draws the stored message once when a push brings it before assist:send answers", async () => {
    const listeners: ((payload: unknown) => void)[] = [];
    const subscribe = window.eo.ipc.subscribe;
    window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: unknown) => void) => {
      if (channel === "items:changed") listeners.push(callback);
      return () => {};
    }) as never;
    try {
      // The main process stores the comment and pushes before its answer to the send is back.
      const { invoke, answer } = heldSend(async () => ({ ok: true, data: { conversation: conversation([sentOne]) } }));
      open("/chat", invoke as never);

      await send("Ship the hotfix.");
      expect(await within(transcript()).findByLabelText("Message sending")).toBeInTheDocument();
      act(() => listeners.forEach((listener) => listener({})));

      await waitFor(() => expect(within(transcript()).queryByLabelText("Message sending")).not.toBeInTheDocument());
      expect(within(transcript()).getAllByText("Ship the hotfix.")).toHaveLength(1);

      await answer({ ok: true, data: { conversation: conversation([sentOne]), delivery: null } });
      expect(within(transcript()).queryByLabelText("Message sending")).not.toBeInTheDocument();
      expect(within(transcript()).getAllByText("Ship the hotfix.")).toHaveLength(1);
    } finally {
      window.eo.ipc.subscribe = subscribe;
    }
  });
});
