import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  GIT_WORKTREE_KIND,
  NO_GIT_STATE,
  REVIEW_ACTION,
  SECTION_LOCK_TEXT,
  developerRegistry,
  toRegistryView,
  type HandOffTargets,
  type ItemSummary,
  type PipelineStepView,
  type StepRouteView,
} from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { AskAssistantContext, type AskAssistant } from "../../askAssistant";
import { GraphView } from "./GraphView";

/** The graph, held to what the classic routing band's suite holds it to (`pipeline/PipelineGraph.test.tsx`). */

function step(id: string, name: string, position: number, overrides: Partial<PipelineStepView> = {}): PipelineStepView {
  return {
    id,
    pipelineId: "default",
    position,
    name,
    type: "agent",
    ownerRole: "implementer",
    entryAction: "implement",
    instructionsSummary: null,
    isTerminal: false,
    workspaceMode: "isolated",
    workspaceId: null,
    planMode: false,
    inputs: {},
    timeoutMs: null,
    watch: null,
    results: [],
    ...overrides,
  };
}

function route(id: string, fromStepId: string, resultKey: string, label: string, target: string, tone: StepRouteView["tone"] = "success"): StepRouteView {
  return { id, pipelineId: "default", fromStepId, resultKey, label, tone, target, position: 0 };
}

const STEPS = [
  step("todo", "To Do", 0),
  step("review", "Review", 1, { ownerRole: "reviewer" }),
  step("done", "Done", 2, { type: "user", ownerRole: null, entryAction: null, isTerminal: true }),
];

const ELSEWHERE: HandOffTargets[] = [{ pipelineId: "merge", pipelineName: "Merge", steps: [step("merge_land", "Merge It", 0, { pipelineId: "merge" })] }];

function item(overrides: Partial<ItemSummary>): ItemSummary {
  return {
    id: "t1",
    key: "EO-1",
    type: "story",
    typeLabel: "Story",
    container: false,
    parentId: null,
    parentKey: null,
    parentTitle: null,
    repositoryId: null,
    repositoryName: null,
    projectId: null,
    title: "Rate limit the API",
    pipelineId: "default",
    stepId: "review",
    pipelineVersion: null,
    stepName: "Review",
    progress: null,
    priority: 0,
    git: NO_GIT_STATE,
    workspace: { kind: "git-worktree", mode: "isolated", label: null },
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

const DEPLOY_MODULE = {
  id: "mod-deploy",
  slug: "deploy",
  name: "Deploy",
  description: "Deploys the branch.",
  approvedAt: 1,
  testCount: 3,
  testRun: null,
  manifest: {
    name: "Deploy",
    description: "Deploys.",
    inputs: { region: { type: "string" as const, default: "eu-west-1" }, dryRun: { type: "boolean" as const } },
    needs: { bin: [], env: ["DEPLOY_TOKEN", "REGION", "SLACK_HOOK"], network: true, item: false, comment: false, attach: false, create: false },
    results: ["deployed", "rolled_back"],
    watch: true,
  },
};

/** The organisation's row for this pipeline, as `sections:list` answers it. */
const PUBLISHED_ROW = {
  section: "pipelines",
  subjectId: "default",
  versionId: "v7-id",
  versionNumber: 7,
  publishedAt: 1_700_000_000_000,
  publishedBy: "dana-id",
  publishedByName: "Dana",
  document: null,
};

/** Captures what the view subscribes to, so a case can deliver the push the main process would send. */
function pushes() {
  const listeners = new Map<string, (() => void)[]>();
  window.eo.ipc.subscribe = vi.fn((channel: string, listener: () => void) => {
    listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
    return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((candidate) => candidate !== listener));
  }) as never;
  return (channel: string) => act(() => (listeners.get(channel) ?? []).forEach((listener) => listener()));
}

interface World {
  steps?: PipelineStepView[];
  routes?: StepRouteView[];
  items?: ItemSummary[];
  versions?: { id: string; pipelineId: string; number: number; createdAt: number; createdBy: string | null; createdByName: string | null }[];
  current?: number | null;
  webhook?: { entry: boolean; unattended: boolean };
  diverged?: boolean;
  locked?: boolean;
  /** Whether the organisation publishes this pipeline: a published row naming it, as the record and a desktop that pulled it both hold. */
  published?: boolean;
  /** The step's references to EO's own environment, which `overrides` lists only when they resolve. */
  references?: { name: string; variable: string; scope: "shared" | "step"; available: boolean }[];
  /** Names with a value stored for the step, readable or not — `overrides` holds only those a run would be given. */
  stored?: string[];
  /** The step's own secrets and variables, by name, with the values a list would carry. */
  secrets?: string[];
  variables?: { name: string; value: string; scope: "shared" | "step" }[];
  verification?: unknown[];
  modules?: unknown[];
  /** What `pipeline:templateStatus` answers (EO-536). Absent is a pipeline made from no template. */
  templateStatus?: unknown;
  /** What work must have to enter (EO-610). Absent is a pipeline that asks for nothing. */
  entrySentence?: string | null;
}

function mockIpc({
  steps = STEPS,
  routes = [] as StepRouteView[],
  items = [] as ItemSummary[],
  versions = [],
  current = null,
  webhook = { entry: false, unattended: false },
  diverged = false,
  locked = false,
  published = false,
  references = [],
  stored = [],
  secrets = [],
  variables = [],
  verification = [],
  modules = [DEPLOY_MODULE],
  templateStatus = { origin: null, updated: null, waiting: null, problem: null },
  entrySentence = null,
}: World = {}) {
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    void payload;
    switch (channel) {
      case "pipelineSteps:list":
        return {
          ok: true,
          data: {
            steps,
            routes,
            entrySentence,
            elsewhere: ELSEWHERE,
            verification,
            version: null,
            finishingOn: [],
            ghosts: [],
            webhook,
            workspaceKind: GIT_WORKTREE_KIND,
            workspaces: [
              { id: "ws-docs", projectId: "b1", kind: "folder", label: "Docs folder", summary: "", problem: null, position: 1, itemCount: 0, config: {} },
            ],
          },
        };
      case "items:list":
        return { ok: true, data: { items } };
      case "projects:list":
        return { ok: true, data: { projects: [{ id: "b1", name: "acme", keyPrefix: "EO", jiraProjectId: null, repositoryIds: [], itemCount: 0 }], activeProjectId: "b1" } };
      case "pipelines:list":
        return { ok: true, data: { pipelines: [{ id: "default", projectId: "b1", name: "Delivery", icon: null, entryStepId: "review", position: 0, archivedAt: null }] } };
      case "registry:get":
        return { ok: true, data: toRegistryView(developerRegistry()) };
      case "modules:list":
        return { ok: true, data: { modules } };
      case "pipeline:versions":
        // Copies, so a case that files a version mid-test is answered with a new list rather than the one already cached.
        return { ok: true, data: { versions: [...versions], current, graph: null, diff: null, local: null } };
      case "sections:list":
        return { ok: true, data: { published: published || diverged ? [PUBLISHED_ROW] : [], locked: locked ? ["pipelines"] : [], lockText: SECTION_LOCK_TEXT } };
      case "pipelines:divergence":
        return {
          ok: true,
          data: diverged
            ? { diverged: true, basedOn: 6, available: 7, line: "Edited locally · based on v6 · v7 available" }
            : { diverged: false, basedOn: null, available: published ? 7 : null, line: null },
        };
      case "moduleSecrets:list":
        return { ok: true, data: { names: [], overrides: [...secrets], organisation: [], references, stored: { shared: [], step: stored } } };
      case "environmentVariables:list":
        return { ok: true, data: { variables } };
      case "pipeline:templateStatus":
        return { ok: true, data: templateStatus };
      default:
        return { ok: true, data: {} };
    }
  });
  window.eo.ipc.invoke = invoke as never;
  return invoke;
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

/** The graph on its own, or — given `ask` — inside a frame that has a conversation to hand the person to. */
function renderGraph(ask: AskAssistant | null = null) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/pipelines/default?view=graph"]}>
        <AskAssistantContext.Provider value={ask}>
          <GraphView pipelineId="default" />
          <Where />
        </AskAssistantContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** What the drawing's list of routes says of each, as "label: from → to" — the marker repeats the end for the eye and is left out. */
const routeLines = () =>
  within(screen.getByRole("list", { name: "Routes" }))
    .getAllByRole("listitem")
    .map((line) => [...line.querySelectorAll(":scope > span:not([aria-hidden])")].map((part) => part.textContent).join(""));

describe("the pipeline's graph", () => {
  it("draws the steps in order, with who owns each and where work enters", async () => {
    mockIpc();
    renderGraph();

    const graph = await screen.findByRole("list", { name: "Pipeline graph" });
    expect(within(graph).getAllByRole("listitem").map((box) => box.getAttribute("data-step"))).toEqual(["todo", "review", "done"]);
    expect(within(graph).getByText("To Do")).toBeInTheDocument();
    expect(within(graph).getByTitle("agent · implementer")).toHaveTextContent("agent");
    expect(await screen.findByText("Delivery")).toBeInTheDocument();
    // The entry step the pipeline names, not the first one drawn.
    expect(await within(screen.getByText("Review").closest("li")!).findByText("start")).toBeInTheDocument();
    expect(within(screen.getByText("To Do").closest("li")!).queryByText("start")).not.toBeInTheDocument();
    // A terminal step is an end, not somebody's step.
    expect(within(screen.getByText("Done").closest("li")!).getByText("end")).toBeInTheDocument();
    expect(screen.getByText("Done").closest("li")!.querySelector("[data-step-kind]")).toBeNull();
    // The steps as published: nothing on them is a draft's addition (EO-680).
    expect(graph.querySelectorAll("[data-new-step]")).toHaveLength(0);
  });

  it("shows a pipeline's entry rules on its entry step, in the words a refusal would use (EO-610)", async () => {
    const sentence = '"Delivery" needs these before work can enter it: a description, a Customer.';
    mockIpc({ entrySentence: sentence });
    renderGraph();

    const graph = await screen.findByRole("list", { name: "Pipeline graph" });
    const entry = graph.querySelector('[data-step="review"]') as HTMLElement;
    expect(within(entry).getByText(sentence)).toBeTruthy();
    expect(within(graph).getAllByText(sentence)).toHaveLength(1);
  });

  it("shows nothing for a pipeline with none (EO-610)", async () => {
    mockIpc();
    renderGraph();

    await screen.findByRole("list", { name: "Pipeline graph" });
    expect(screen.queryByText(/before work can enter/)).toBeNull();
  });

  it("draws the route to the next step as an arrow labelled with the result that takes it", async () => {
    mockIpc({ routes: [route("r1", "todo", "done", "Implemented", "review")] });
    const { container } = renderGraph();

    expect(await screen.findByText("Implemented")).toBeInTheDocument();
    expect(routeLines()).toContain("Implemented: To Do → Review");
    // A line and an arrowhead, neither dashed: it goes the way everything goes.
    const arrow = container.querySelector('[data-route="r1"]')!;
    expect(arrow.querySelectorAll("path")).toHaveLength(2);
    expect(arrow.querySelector("path")).not.toHaveAttribute("stroke-dasharray");
  });

  it("labels an arrow with the result key when the route has no label", async () => {
    mockIpc({ routes: [route("r1", "todo", "done", "", "review")] });
    renderGraph();

    expect(await screen.findByText("done")).toBeInTheDocument();
  });

  it("draws a send-back as an arrow going back up, dashed", async () => {
    mockIpc({ routes: [route("r1", "review", "changes_requested", "Changes requested", "todo")] });
    const { container } = renderGraph();

    await screen.findByText("Changes requested");
    expect(routeLines()).toContain("Changes requested: Review → To Do");
    expect(container.querySelector('[data-route="r1"] path')).toHaveAttribute("stroke-dasharray");
    expect(screen.getByText(/Review on Changes requested goes to To Do/)).toBeInTheDocument();
  });

  it("ends a route out to another pipeline, to you, or to the end at a marker naming it", async () => {
    mockIpc({
      routes: [
        route("r1", "review", "approved", "Approved", "merge_land"),
        route("r2", "todo", "needs_user_input", "Needs input", "user_attention", "warning"),
        route("r3", "todo", "cancelled", "Cancelled", "terminal", "danger"),
      ],
    });
    renderGraph();

    expect(await screen.findByText("Merge · Merge It")).toBeInTheDocument();
    expect(screen.getByText("you")).toBeInTheDocument();
    expect(screen.getByText("the end")).toBeInTheDocument();
    expect(routeLines()).toContain("Approved: Review → Merge · Merge It");
    expect(screen.getByText(/Review on Approved goes to Merge · Merge It/)).toBeInTheDocument();
  });

  it("draws a route out to you in amber, a failure in red, a send-back neutral and the next step plain (EO-686)", async () => {
    mockIpc({
      routes: [
        route("r1", "todo", "done", "Implemented", "review"),
        // Out to you by where it goes, whatever tone it was given — a failure included.
        route("r2", "todo", "needs_user_input", "Needs input", "user_attention", "info"),
        route("r3", "todo", "blocked", "Blocked", "todo", "warning"),
        route("r4", "review", "failed", "Failed", "todo", "danger"),
        route("r5", "review", "changes_requested", "Changes requested", "todo", "warning"),
        route("r6", "review", "broken", "Could not open", "user_attention", "danger"),
      ],
    });
    const { container } = renderGraph();

    await screen.findByText("Implemented");
    const line = (id: string) => container.querySelector(`[data-route="${id}"]`)!;
    expect(line("r1")).toHaveClass("text-line-strong");
    expect(screen.getByText("Implemented")).toHaveClass("text-ink-muted");
    for (const [id, label] of [
      ["r2", "Needs input"],
      ["r6", "Could not open"],
    ] as const) {
      expect(line(id)).toHaveClass("text-paused");
      expect(screen.getByText(label)).toHaveClass("text-paused");
    }
    // A send-back, to its own step or an earlier one, is rework, not waiting: neutral and dashed.
    for (const [id, label] of [
      ["r3", "Blocked"],
      ["r5", "Changes requested"],
    ] as const) {
      expect(line(id)).toHaveClass("text-ink-subtle/70");
      expect(line(id).querySelector("path")).toHaveAttribute("stroke-dasharray", "4 3");
      expect(screen.getByText(label)).toHaveClass("text-ink-subtle");
      expect(screen.getByText(label).className).not.toMatch(/paused|danger/);
    }
    expect(line("r4")).toHaveClass("text-danger");
    expect(screen.getByText("Failed")).toHaveClass("text-danger");
    // Where it lands with you: a solid marker on a light amber fill.
    for (const marker of screen.getAllByText("you")) {
      expect(marker).toHaveClass("text-paused", "border-solid");
      expect(marker.className).toContain("bg-[color:color-mix(in_oklab,var(--color-canvas),var(--color-paused)_16%)]");
      expect(marker).not.toHaveClass("border-dashed");
    }
  });

  it("strips each step that holds work by the state of what is on it, as the board does, and leaves an empty step bare (EO-686)", async () => {
    mockIpc({
      items: [
        item({ id: "t1", key: "EO-1", latestRunStatus: "running" }),
        item({ id: "t2", key: "EO-2", latestRunStatus: "queued" }),
        item({ id: "t3", key: "EO-3", latestRunStatus: "failed" }),
        item({ id: "t4", key: "EO-4", latestRunStatus: "awaiting_input" }),
        // Waiting on you is waiting, whatever its run did.
        item({ id: "t8", key: "EO-8", latestRunStatus: "succeeded", needsAttention: true }),
        item({ id: "t5", key: "EO-5", latestRunStatus: "succeeded" }),
        item({ id: "t6", key: "EO-6", latestRunStatus: null }),
        // Held work is parked, and counted nowhere.
        item({ id: "t7", key: "EO-7", latestRunStatus: "failed", heldAt: 5 }),
      ],
    });
    const { container } = renderGraph();

    await screen.findByRole("link", { name: "7 here" });
    const box = (id: string) => container.querySelector<HTMLElement>(`[data-step="${id}"]`)!;
    const strip = box("review").querySelector<HTMLElement>("[data-load-strip]")!;
    expect(strip).toHaveAttribute("aria-label", "1 failed, 2 waiting, 2 running, 2 idle");
    expect([...strip.children].map((segment) => [segment.getAttribute("data-load"), (segment as HTMLElement).style.flexGrow])).toEqual([
      ["danger", "1"],
      ["paused", "2"],
      ["running", "2"],
      ["idle", "2"],
    ]);
    expect(box("todo").querySelector("[data-load-strip]")).toBeNull();
    expect(box("done").querySelector("[data-load-strip]")).toBeNull();
  });

  it("counts work on a step that runs the review action as in review, unless it failed or waits (EO-686)", async () => {
    mockIpc({
      steps: [STEPS[0]!, { ...STEPS[1]!, entryAction: REVIEW_ACTION }, STEPS[2]!],
      items: [
        item({ id: "t1", key: "EO-1", latestRunStatus: "running" }),
        item({ id: "t2", key: "EO-2", latestRunStatus: null }),
        item({ id: "t3", key: "EO-3", latestRunStatus: "failed" }),
      ],
    });
    const { container } = renderGraph();

    await screen.findByRole("link", { name: "3 here" });
    const strip = container.querySelector<HTMLElement>('[data-step="review"] [data-load-strip]')!;
    expect(strip).toHaveAttribute("aria-label", "1 failed, 2 in review");
    expect([...strip.children].map((segment) => segment.className.match(/\bbg-[a-z]+/)?.[0])).toEqual(["bg-danger", "bg-reviewing"]);
  });

  it("says above the drawing what its lines and dots mean (EO-686)", async () => {
    mockIpc();
    renderGraph();

    const legend = await screen.findByRole("list", { name: "Legend" });
    expect(within(legend).getAllByRole("listitem").map((entry) => entry.textContent)).toEqual(
      expect.arrayContaining(["next", "sends back", "lands with you", "failed", "step owner:", "agent", "person", "script", "EO"]),
    );
    const sample = (word: string) => legend.querySelector(`[data-legend-route="${word}"] svg`)!;
    expect(sample("next")).toHaveClass("text-line-strong");
    expect(sample("sends back")).toHaveClass("text-ink-subtle/70");
    expect(sample("sends back").querySelector("path")).toHaveAttribute("stroke-dasharray", "4 3");
    expect(sample("lands with you")).toHaveClass("text-paused");
    expect(sample("failed")).toHaveClass("text-danger");
    expect(legend.querySelector('[data-legend-owner="EO"] [data-step-kind-dot]')!.className).toContain("border-ink-subtle");
  });

  it("draws nothing for a target in no pipeline at all", async () => {
    mockIpc({ routes: [route("r1", "review", "approved", "Approved", "typo")] });
    const { container } = renderGraph();

    await screen.findByRole("list", { name: "Pipeline graph" });
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
    expect(container.querySelector("[data-route]")).toBeNull();
  });

  it("is as wide as its boxes and arrows need, and scrolls in its own frame when the canvas is narrower", async () => {
    mockIpc({ routes: [route("r1", "review", "changes_requested", "Changes requested", "todo"), route("r2", "todo", "cancelled", "Cancelled", "terminal")] });
    const { container } = renderGraph();

    await screen.findByText("Changes requested");
    const frame = container.querySelector("[data-pipeline-drawing]")!;
    expect(frame).toHaveClass("max-w-full", "overflow-x-auto");
    // Everything is placed inside one sheet of a fixed size: no box is sized by the room it is given.
    const sheet = screen.getByRole("list", { name: "Pipeline graph" }).parentElement!;
    const [width, height] = [parseFloat(sheet.style.width), parseFloat(sheet.style.height)];
    expect(width).toBeGreaterThan(0);
    for (const box of within(sheet).getAllByRole("listitem").filter((node) => node.hasAttribute("data-step"))) {
      expect(parseFloat(box.style.width)).toBeGreaterThanOrEqual(176);
      expect(parseFloat(box.style.left) + parseFloat(box.style.width)).toBeLessThanOrEqual(width);
      expect(parseFloat(box.style.top) + parseFloat(box.style.height)).toBeLessThanOrEqual(height);
    }
  });

  it("says how much stands on a step, and opens the board narrowed to it", async () => {
    mockIpc({ items: [item({}), item({ id: "t2", key: "EO-2" }), item({ id: "t3", key: "EO-3", heldAt: 5 })] });
    renderGraph();

    const here = await screen.findByRole("link", { name: "2 here" });
    expect(here).toHaveAttribute("href", "/pipelines/default?step=review");
  });

  it("switches back to the board, and offers no way to the configure screen", async () => {
    mockIpc();
    renderGraph();

    await screen.findByRole("list", { name: "Pipeline graph" });
    const views = screen.getByRole("navigation", { name: "Pipeline views" });
    expect(within(views).getAllByRole("link").map((link) => link.textContent)).toEqual(["Board", "Graph"]);
    expect(within(views).getByRole("link", { name: "Graph" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Configure" })).toBeNull();
    fireEvent.click(within(views).getByRole("link", { name: "Board" }));
    expect(screen.getByTestId("where").textContent).toBe("/pipelines/default");
  });

  it("says so when there are no steps, and points to the assistant rather than a configure screen", async () => {
    mockIpc({ steps: [] });
    const ask = vi.fn();
    renderGraph(ask);

    expect(await screen.findByText("No steps yet.")).toBeInTheDocument();
    expect(screen.getByText(/to the assistant/)).toBeInTheDocument();
    expect(screen.queryByText(/configure/i)).toBeNull();
    expect(screen.queryByRole("link", { name: "Configure" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask the assistant" }));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("goes to the chat from an empty graph when no conversation is beside it", async () => {
    mockIpc({ steps: [] });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Ask the assistant" }));
    expect(screen.getByTestId("where").textContent).toBe("/chat");
  });
});

/** The open step's details, as a definition list: each term and what it says. */
function detailsOf(): Record<string, string> {
  const list = document.querySelector('dl[aria-label="Step details"]')!;
  const terms = [...list.querySelectorAll("dt")].map((term) => term.textContent ?? "");
  const values = [...list.querySelectorAll("dd")].map((value) => value.textContent ?? "");
  return Object.fromEntries(terms.map((term, index) => [term, values[index] ?? ""]));
}

const DEPLOY = step("deploy", "Deploy", 1, {
  type: "module",
  ownerRole: null,
  entryAction: "mod-deploy",
  inputs: { dryRun: true },
  timeoutMs: 20 * 60_000,
  watch: { everyMinutes: 5, giveUpAfterHours: 12 },
  workspaceId: "ws-docs",
});

describe("a step's details, read-only (EO-524)", () => {
  it("opens when a step's name is pressed: who acts and the action it runs", async () => {
    mockIpc();
    renderGraph();

    expect(screen.queryByRole("list", { name: "Results" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "To Do" }));

    const details = screen.getByRole("region", { name: "To Do" });
    expect(within(details).getByText("An agent — implementer")).toBeInTheDocument();
    expect(detailsOf()).toMatchObject({ "Who acts": "An agent — implementer", Action: "implement" });
    expect(screen.getByRole("button", { name: "To Do" })).toHaveAttribute("aria-pressed", "true");
    // Pressed again, it closes.
    fireEvent.click(screen.getByRole("button", { name: "To Do" }));
    expect(screen.queryByRole("region", { name: "To Do" })).toBeNull();
  });

  /**
   * The kind chip the drawing it was opened from draws (EO-680), on the
   * heading's line (EO-681): one each for an agent's, a person's and a
   * script's step, and none for where work ends.
   */
  it("shows the step's kind beside its name in the header, and none for an end", async () => {
    mockIpc({ steps: [STEPS[0]!, DEPLOY, step("approve", "Approve", 2, { type: "user", ownerRole: null, entryAction: null }), { ...STEPS[2]!, position: 3 }] });
    renderGraph();
    const chipIn = (name: string) => {
      const details = screen.getByRole("region", { name });
      const heading = within(details).getByRole("heading", { name });
      return heading.parentElement?.querySelector("[data-step-kind]")?.getAttribute("data-step-kind") ?? null;
    };

    fireEvent.click(await screen.findByRole("button", { name: "To Do" }));
    expect(chipIn("To Do")).toBe("agent");
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    expect(chipIn("Deploy")).toBe("script");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(chipIn("Approve")).toBe("person");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(within(screen.getByRole("region", { name: "Done" })).queryByText("person")).toBeNull();
    expect(screen.getByRole("region", { name: "Done" }).querySelector("[data-step-kind]")).toBeNull();
  });

  it("names the built-in function a step runs, by its label", async () => {
    mockIpc({ steps: [step("pr", "Open PR", 0, { type: "builtin", ownerRole: null, entryAction: "open_pull_request" })] });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Open PR" }));
    await waitFor(() => expect(detailsOf()["Built-in function"]).toBe("Open the pull request open_pull_request"));
    expect(detailsOf()["Who acts"]).toBe("EO itself — built in");
  });

  it("says who a person's step waits on", async () => {
    mockIpc({
      steps: [step("approve", "Approve", 0, { type: "user", ownerRole: null, entryAction: null })],
      verification: [{ stepId: "approve", checks: [], verifiesAction: false, kindVerifies: false, waitsOn: "Dana", waitsOnKind: "person" }],
    });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(detailsOf()["Who acts"]).toBe("A person — waits on Dana"));
    // A person's step runs nothing, so it has nothing of a run's to show.
    expect(detailsOf()).not.toHaveProperty("Time limit");
    expect(screen.queryByRole("region", { name: "Variables and secrets" })).toBeNull();
  });

  it("says a step that never gives up never does, instead of an hour count (EO-571)", async () => {
    mockIpc({ steps: [STEPS[0]!, { ...DEPLOY, watch: { everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true } }] });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(detailsOf()["Keep checking"]).toBe("Every 5 minutes, never giving up"));
  });

  it("shows a module step's module, inputs, time limit, keep checking and workspace", async () => {
    mockIpc({ steps: [STEPS[0]!, DEPLOY] });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(detailsOf()["Module"]).toBe("Deploy"));
    const details = detailsOf();
    expect(details["Who acts"]).toBe("A module — one of your own");
    // What the step set, and the default where it set nothing.
    expect(details["Inputs"]).toContain("region: eu-west-1 (the default)");
    expect(details["Inputs"]).toContain("dryRun: true");
    expect(details["Time limit"]).toBe("20 minutes");
    expect(details["Keep checking"]).toBe("Every 5 minutes, giving up after 12 hours");
    expect(details["Works on"]).toBe("Docs folder");
    // A folder is not a repository, so there is no mode to state.
    expect(details).not.toHaveProperty("Repository");
  });

  it("says which repository mode a step on the item's own git workspace takes, and EO's defaults where none is set", async () => {
    mockIpc({ steps: [step("todo", "To Do", 0, { workspaceMode: "read" })] });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "To Do" }));
    const details = detailsOf();
    expect(details["Works on"]).toMatch(/own workspace/);
    expect(details["Repository"]).toBe("Reads only");
    expect(details["Time limit"]).toBe("None of its own");
    expect(details["Keep checking"]).toBe("Off");
    expect(details["Inputs"]).toBe("None");
  });

  it("lists each result and where it routes", async () => {
    mockIpc({
      routes: [
        route("r1", "review", "approved", "Approved", "done"),
        route("r2", "review", "changes_requested", "Changes requested", "todo", "warning"),
        route("r3", "review", "needs_user_input", "", "user_attention", "warning"),
        route("r4", "todo", "done", "Implemented", "review"),
      ],
    });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    const results = within(screen.getByRole("region", { name: "Results" })).getAllByRole("listitem").map((line) => line.textContent);
    expect(results).toEqual(["Approved approved → Done", "Changes requested changes_requested → To Do", "needs_user_input → you"]);
  });

  it("says where a declared result no route names goes: it parks and asks, beside the routes it does have", async () => {
    mockIpc({ steps: [STEPS[0]!, DEPLOY, STEPS[2]!], routes: [route("r1", "deploy", "deployed", "Deployed", "done")] });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Deploy" }));
    const results = await screen.findByRole("region", { name: "Results" });
    await waitFor(() => expect(within(results).getAllByRole("listitem")).toHaveLength(3));
    expect(within(results).getAllByRole("listitem").map((line) => line.textContent)).toEqual([
      "Deployed deployed → Done",
      "Rolled back rolled_back → stays here and asks you — no route names it",
      // The module can keep checking, so it has `waiting` though its results leave it out.
      "Waiting waiting → stays here, and EO checks again",
    ]);
  });

  it("walks every result of a step that routes nothing to the next step, and says so", async () => {
    mockIpc({ steps: [STEPS[0]!, DEPLOY, STEPS[2]!] });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Deploy" }));
    const results = await screen.findByRole("region", { name: "Results" });
    await waitFor(() => expect(within(results).getAllByRole("listitem")).toHaveLength(3));
    expect(within(results).getAllByRole("listitem").map((line) => line.textContent)).toEqual([
      "Deployed deployed → Done, the next step — this step routes nothing",
      "Rolled back rolled_back → Done, the next step — this step routes nothing",
      "Waiting waiting → stays here, and EO checks again",
    ]);
    expect(within(results).queryByText(/No result routes/)).toBeNull();
  });

  it("parks a route-free built-in step's results and asks when there is no step after it", async () => {
    mockIpc({ steps: [STEPS[0]!, step("pr", "Open PR", 5, { type: "builtin", ownerRole: null, entryAction: "open_pull_request" })] });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Open PR" }));
    const results = await screen.findByRole("region", { name: "Results" });
    await waitFor(() => expect(within(results).getAllByRole("listitem").length).toBeGreaterThan(0));
    for (const line of within(results).getAllByRole("listitem")) {
      expect(line).toHaveTextContent("→ stays here and asks you — no route, and no step after this one");
    }
  });

  it("says a step that keeps checking holds work on waiting, which no route can name", async () => {
    const WAITS = step("wait", "Wait for deploy", 1, { type: "module", ownerRole: null, entryAction: "mod-waits", watch: { everyMinutes: 5, giveUpAfterHours: 24 } });
    mockIpc({
      steps: [STEPS[0]!, WAITS, STEPS[2]!],
      routes: [route("r1", "wait", "deployed", "Deployed", "done")],
      modules: [{ ...DEPLOY_MODULE, id: "mod-waits", manifest: { ...DEPLOY_MODULE.manifest, results: ["deployed", "waiting"] } }],
    });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Wait for deploy" }));
    const results = await screen.findByRole("region", { name: "Results" });
    await waitFor(() => expect(within(results).getAllByRole("listitem")).toHaveLength(2));
    expect(within(results).getAllByRole("listitem")[1]).toHaveTextContent("waiting → stays here, and EO checks again");
  });

  it("says a real checking builtin waits, though its declared results leave waiting out", async () => {
    const WATCH = step("watch", "Watch PR", 1, { type: "builtin", ownerRole: null, entryAction: "watch_pull_request", watch: { everyMinutes: 10, giveUpAfterHours: 72 } });
    mockIpc({ steps: [STEPS[0]!, WATCH, STEPS[2]!], routes: [route("r1", "watch", "merged", "Merged", "done")] });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Watch PR" }));
    const results = await screen.findByRole("region", { name: "Results" });
    await waitFor(() => expect(within(results).getAllByRole("listitem").length).toBeGreaterThan(1));
    const lines = within(results).getAllByRole("listitem").map((line) => line.textContent);
    expect(lines[0]).toBe("Merged merged → Done");
    expect(lines.at(-1)).toBe("Waiting waiting → stays here, and EO checks again");
    expect(lines.filter((line) => line?.includes("waiting"))).toHaveLength(1);
  });

  it("says a watch-capable module that runs once parks on waiting, though its results leave waiting out", async () => {
    const ONCE = step("once", "Deploy once", 1, { type: "module", ownerRole: null, entryAction: "mod-deploy", watch: null });
    mockIpc({ steps: [STEPS[0]!, ONCE, STEPS[2]!], routes: [route("r1", "once", "deployed", "Deployed", "done"), route("r2", "once", "rolled_back", "Rolled back", "todo")] });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Deploy once" }));
    const results = await screen.findByRole("region", { name: "Results" });
    await waitFor(() => expect(within(results).getAllByRole("listitem")).toHaveLength(3));
    expect(within(results).getAllByRole("listitem")[2]).toHaveTextContent("waiting → stays here and asks you — it runs once, so keep checking would have to be on");
  });

  it("names nothing waiting on a function that cannot wait", async () => {
    mockIpc({ steps: [STEPS[0]!, step("pr", "Open PR", 1, { type: "builtin", ownerRole: null, entryAction: "open_pull_request" }), STEPS[2]!] });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Open PR" }));
    const results = await screen.findByRole("region", { name: "Results" });
    await waitFor(() => expect(within(results).getAllByRole("listitem").length).toBeGreaterThan(0));
    expect(within(results).queryByText("waiting")).toBeNull();
  });

  it("keeps a step secret whose stored value no longer decrypts, marked not set, and shows no value", async () => {
    mockIpc({ steps: [STEPS[0]!, step("ag", "Agent step", 1)], stored: ["TOKEN"], secrets: [], references: [] });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Agent step" }));
    const values = await screen.findByRole("region", { name: "Variables and secrets" });
    await waitFor(() => expect(within(values).getByText("TOKEN").closest("li")).toHaveTextContent("secret · not set — its stored value cannot be read"));
    expect(within(values).queryByText(/None of its own/)).toBeNull();
    expect(within(values).getByText("TOKEN").closest("li")).not.toHaveTextContent("secret · set");
  });

  it("does not mark a stored secret that reads as unreadable", async () => {
    mockIpc({ steps: [STEPS[0]!, step("ag", "Agent step", 1)], stored: ["TOKEN"], secrets: ["TOKEN"] });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Agent step" }));
    const values = await screen.findByRole("region", { name: "Variables and secrets" });
    await waitFor(() => expect(within(values).getByText("TOKEN").closest("li")).toHaveTextContent("secret · set"));
    expect(within(values).getAllByRole("listitem")).toHaveLength(1);
  });

  it("marks a step secret whose reference does not resolve as not set, and shows no value", async () => {
    mockIpc({
      steps: [STEPS[0]!, DEPLOY],
      references: [
        { name: "DEPLOY_TOKEN", variable: "CI_DEPLOY_TOKEN", scope: "step", available: false },
        { name: "SHARED_TOKEN", variable: "SHARED_TOKEN", scope: "shared", available: false },
      ],
    });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Deploy" }));
    const values = await screen.findByRole("region", { name: "Variables and secrets" });
    await waitFor(() => expect(within(values).getByText("DEPLOY_TOKEN").closest("li")).toHaveTextContent("secret · not set — its variable is missing"));
    expect(within(values).getByText("DEPLOY_TOKEN").closest("li")).not.toHaveTextContent("secret · set");
    // A shared reference is not the step's own, and nothing it reads is drawn.
    expect(within(values).queryByText("SHARED_TOKEN")).toBeNull();
    expect(document.body.textContent).not.toContain("CI_DEPLOY_TOKEN");
  });

  it("shows a secret set from the assistant's card while the step is open, once the configuration push arrives", async () => {
    const push = pushes();
    const secrets: string[] = [];
    mockIpc({ steps: [STEPS[0]!, DEPLOY], secrets });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Deploy" }));
    const values = await screen.findByRole("region", { name: "Variables and secrets" });
    await waitFor(() => expect(within(values).getByText("DEPLOY_TOKEN").closest("li")).toHaveTextContent("not set"));
    secrets.push("DEPLOY_TOKEN");
    push("config:changed");
    await waitFor(() => expect(within(values).getByText("DEPLOY_TOKEN").closest("li")).toHaveTextContent("secret · set"));
  });

  it("names the step's own variables and secrets, set or not, and never their values", async () => {
    mockIpc({
      steps: [STEPS[0]!, DEPLOY],
      secrets: ["DEPLOY_TOKEN"],
      variables: [
        { name: "REGION", value: "eu-central-1-the-value", scope: "step" },
        { name: "SHARED_ONLY", value: "shared-value", scope: "shared" },
      ],
    });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Deploy" }));
    const values = await screen.findByRole("region", { name: "Variables and secrets" });
    await waitFor(() => expect(within(values).getAllByRole("listitem")).toHaveLength(3));
    expect(within(values).getAllByRole("listitem").map((line) => line.textContent)).toEqual([
      "DEPLOY_TOKENsecret · set",
      "REGIONvariable · set",
      "SLACK_HOOKnot set",
    ]);
    // A shared variable is not the step's own, and no value is ever drawn.
    expect(screen.queryByText("SHARED_ONLY")).toBeNull();
    expect(document.body.textContent).not.toContain("eu-central-1-the-value");
    expect(document.body.textContent).not.toContain("shared-value");
  });
});

describe("the pipeline's own setup, read-only (EO-524)", () => {
  const VERSIONS = [
    { id: "v1", pipelineId: "default", number: 1, createdAt: 1_700_000_000_000, createdBy: null, createdByName: null },
    { id: "v2", pipelineId: "default", number: 2, createdAt: 1_700_000_100_000, createdBy: "p1", createdByName: "Dana" },
    { id: "v3", pipelineId: "default", number: 3, createdAt: 1_700_000_200_000, createdBy: "p2", createdByName: null },
  ];

  it("lists every version, newest first, with who saved it and when", async () => {
    mockIpc({ versions: VERSIONS, current: 3 });
    renderGraph();

    const list = await screen.findByRole("list", { name: "Versions" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(within(list).getAllByRole("listitem").map((line) => line.getAttribute("aria-label"))).toEqual(["v3", "v2", "v1"]);
    const v2 = within(list).getByRole("listitem", { name: "v2" });
    expect(v2).toHaveTextContent("Saved by Dana");
    expect(v2).toHaveTextContent(new Date(1_700_000_100_000).toLocaleString());
    expect(within(list).getByRole("listitem", { name: "v1" })).toHaveTextContent("Saved by EO");
    expect(within(list).getByRole("listitem", { name: "v3" })).toHaveTextContent("Current");
  });

  it("opens each version's Changes view against the version before, and offers none for the first", async () => {
    mockIpc({ versions: VERSIONS, current: 3 });
    renderGraph();

    const list = await screen.findByRole("list", { name: "Versions" });
    expect(await within(list).findByRole("link", { name: "What v3 changed" })).toHaveAttribute("href", "/pipelines/default/changes?from=2&to=3");
    expect(within(list).getByRole("link", { name: "What v2 changed" })).toHaveAttribute("href", "/pipelines/default/changes?from=1&to=2");
    expect(within(within(list).getByRole("listitem", { name: "v1" })).queryByRole("link")).toBeNull();
    fireEvent.click(within(list).getByRole("link", { name: "What v3 changed" }));
    expect(screen.getByTestId("where").textContent).toBe("/pipelines/default/changes?from=2&to=3");
  });

  it("says whether webhook items are sent on unread", async () => {
    mockIpc({ webhook: { entry: true, unattended: true } });
    const { unmount } = renderGraph();
    const settings = await screen.findByRole("region", { name: "Pipeline settings" });
    await waitFor(() => expect(settings).toHaveTextContent(/Sent on unread/));
    unmount();

    mockIpc({ webhook: { entry: true, unattended: false } });
    renderGraph();
    await waitFor(() => expect(screen.getByRole("region", { name: "Pipeline settings" })).toHaveTextContent("Read by a person before any step that sends."));
  });

  it("says whether it is the organisation's, and opens a diverged copy's own edits", async () => {
    mockIpc({ diverged: true });
    const { unmount } = renderGraph();
    const settings = await screen.findByRole("region", { name: "Pipeline settings" });
    await waitFor(() => expect(settings).toHaveTextContent(/this machine's copy has diverged/));
    expect(within(settings).getByRole("link", { name: "See your edits" })).toHaveAttribute("href", "/pipelines/default/changes?local");
    unmount();

    mockIpc();
    renderGraph();
    await waitFor(() => expect(screen.getByRole("region", { name: "Pipeline settings" })).toHaveTextContent("No — this machine's own pipeline."));
  });

  /**
   * Whose a pipeline is comes from what was published, not from the lock.
   * The organisation's own record holds no lock over the pipelines it
   * publishes, and it is exactly where calling one "this machine's own"
   * would be wrong.
   */
  it("calls a published pipeline the organisation's where nothing is locked, as on the record itself", async () => {
    mockIpc({ published: true, locked: false });
    renderGraph();

    const settings = await screen.findByRole("region", { name: "Pipeline settings" });
    await waitFor(() => expect(settings).toHaveTextContent("Yes — your organisation publishes it (v7, by Dana), and this machine's copy follows what it publishes."));
    expect(within(settings).queryByRole("link", { name: "See your edits" })).toBeNull();
  });

  it("does not call a pipeline the organisation's because the section is locked", async () => {
    mockIpc({ locked: true });
    renderGraph();

    await waitFor(() => expect(screen.getByRole("region", { name: "Pipeline settings" })).toHaveTextContent("No — this machine's own pipeline."));
  });

  it("shows a version filed while it is open, once the configuration push arrives", async () => {
    const push = pushes();
    const versions = VERSIONS.slice(0, 2);
    mockIpc({ versions, current: 2 });
    renderGraph();

    const list = await screen.findByRole("list", { name: "Versions" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    // The assistant's card publishes v3 beside the open view.
    versions.unshift(VERSIONS[2]!);
    push("config:changed");

    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(within(list).getByRole("link", { name: "What v3 changed" })).toHaveAttribute("href", "/pipelines/default/changes?from=2&to=3");
  });

  it("has no input and nothing that writes — only steps to open and the way to the assistant", async () => {
    mockIpc({ steps: [STEPS[0]!, DEPLOY], versions: VERSIONS, current: 3, webhook: { entry: true, unattended: false }, diverged: true, secrets: ["DEPLOY_TOKEN"] });
    const ask = vi.fn();
    renderGraph(ask);

    fireEvent.click(await screen.findByRole("button", { name: "Deploy" }));
    await screen.findByRole("region", { name: "Variables and secrets" });
    await screen.findByRole("link", { name: "What v3 changed" });
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Ask the assistant", "To Do", "Deploy"]);
    for (const role of ["textbox", "combobox", "checkbox", "switch", "spinbutton", "radio"]) expect(screen.queryAllByRole(role)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Ask the assistant" }));
    expect(ask).toHaveBeenCalledTimes(1);
  });
});


describe("the graph's head, for a pipeline made from a template (EO-536)", () => {
  const ORIGIN = { slug: "software-feature-to-merge", title: "Software feature to merge", version: "1.1" };

  it("names the template and its version, and nothing for a pipeline with no origin", async () => {
    mockIpc({ templateStatus: { origin: ORIGIN, updated: null, waiting: null, problem: null } });
    const { unmount } = renderGraph();

    const head = (await screen.findByText("From Software feature to merge v1.1")).closest("header");
    expect(head).not.toBeNull();
    unmount();

    mockIpc();
    renderGraph();
    await screen.findByRole("list", { name: "Pipeline graph" });
    expect(screen.queryByText(/^From /)).toBeNull();
  });

  it("says Updated to vN with its release notes a click away, and Update waiting with its count", async () => {
    mockIpc({
      templateStatus: {
        origin: ORIGIN,
        updated: { version: "1.1", pipelineVersion: 3, at: 1, notes: "Adds Watching pull request." },
        waiting: { conflictId: "c-1", fromVersion: "1.1", toVersion: "1.2", conflicts: 1, problems: 0, chatId: null, notice: { itemId: "thread-1", commentId: "n-1" } },
        problem: null,
      },
    });
    renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: /^Updated to v1\.1/ }));
    expect(within(await screen.findByRole("dialog")).getByLabelText("Release notes")).toHaveTextContent("Adds Watching pull request.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(await screen.findByRole("button", { name: "Update waiting: 1 conflict — see the notice" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/items/thread-1"));
  });
});

describe("the graph's history, for a version a template update wrote (EO-536)", () => {
  it("labels that version as a template update and no other", async () => {
    mockIpc({
      versions: [
        { id: "v1", pipelineId: "default", number: 1, createdAt: 1, createdBy: "dana-id", createdByName: "Dana" },
        { id: "v2", pipelineId: "default", number: 2, createdAt: 2, createdBy: "template:software-feature-to-merge@1.1", createdByName: "the software-feature-to-merge 1.1 template update" },
      ],
      current: 2,
    });
    renderGraph();

    const versions = await screen.findByRole("list", { name: "Versions" });
    const v2 = await within(versions).findByRole("listitem", { name: "v2" });
    expect(within(v2).getByText("Template update")).toBeInTheDocument();
    expect(within(within(versions).getByRole("listitem", { name: "v1" })).queryByText("Template update")).toBeNull();
  });
});
