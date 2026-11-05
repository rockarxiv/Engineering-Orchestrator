import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import { MemoryRouter } from "react-router-dom";
import { pipelineChangesPath } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { AskAssistantContext, type AskAssistant } from "../../askAssistant";
import { PipelineChangesView } from "./PipelineChangesView";

/**
 * The chat layout's Changes view (EO-524), held to the classic
 * `PipelineChanges` tests line for line where they still apply.
 *
 * "View changes" (EO-327, ARCHITECTURE.md, "Publish, lock and versions"):
 * a read-only diff of steps, routes and prompts, at an address of its own
 * that says which versions are compared.
 *
 * Read-only is the part worth a test of its own. This screen is reached
 * from a banner about work somebody else's save affected, and the one
 * thing it must never offer is a way to publish over it.
 */
const ANSWER = {
  versions: [
    { id: "v1", pipelineId: "default", number: 1, createdAt: 1, createdBy: null, createdByName: null },
    { id: "v2", pipelineId: "default", number: 2, createdAt: 2, createdBy: "p1", createdByName: "Dana" },
  ],
  diff: {
    from: 1,
    to: 2,
    steps: [
      {
        stepId: "review",
        name: "Second look",
        change: "changed" as const,
        fields: [
          { field: "name", before: "Review", after: "Second look" },
          { field: "instructionsSummary", before: null, after: "Look again." },
        ],
      },
      { stepId: "qa", name: "QA", change: "removed" as const, fields: [] },
    ],
    routes: [
      {
        fromStepName: "Second look",
        resultKey: "approved",
        change: "changed" as const,
        // A target *and* a label, because a save changes both and the
        // screen has to draw both (EO-327): a route diff that only ever
        // showed where a branch goes said nothing about renaming it.
        fields: [
          { field: "target", before: "QA", after: "Done" },
          { field: "label", before: "Approve", after: "Ship it" },
        ],
      },
    ],
  },
};

function mockIpc(answer: unknown = ANSWER) {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    void payload;
    switch (channel) {
      case "pipeline:versions":
        return { ok: true, data: answer };
      case "projects:list":
        return { ok: true, data: { projects: [{ id: "b1", name: "acme", keyPrefix: "EO", jiraProjectId: null, repositoryIds: [], itemCount: 0 }], activeProjectId: "b1" } };
      case "pipelines:list":
        return { ok: true, data: { pipelines: [{ id: "default", projectId: "b1", name: "Delivery", icon: null, entryStepId: null, position: 0, archivedAt: null }] } };
      default:
        return { ok: true, data: {} };
    }
  });
  window.eo.ipc.invoke = invoke as never;
  return invoke;
}

/** What `pipeline:versions` was asked, each time. */
const versionsAsked = (invoke: ReturnType<typeof mockIpc>) => invoke.mock.calls.filter((call) => call[0] === "pipeline:versions").map((call) => call[1]);

function renderChanges(path = pipelineChangesPath("default"), ask: AskAssistant | null = null) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <AskAssistantContext.Provider value={ask}>
            <PipelineChangesView pipelineId="default" />
          </AskAssistantContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("the read-only diff between two versions", () => {
  it("says what changed about a step, field by field", async () => {
    mockIpc();
    renderChanges();

    await screen.findByText("instructionsSummary");
    expect(screen.getAllByText("Second look").length).toBeGreaterThan(0);
    expect(screen.getByText("Look again.")).toBeTruthy();
    // A removed step is a change too, and says so rather than simply
    // being absent.
    expect(screen.getAllByText("QA").length).toBeGreaterThan(0);
    expect(screen.getByText("removed")).toBeTruthy();
  });

  it("says where a route goes now, and where it went before", async () => {
    mockIpc();
    renderChanges();

    await screen.findByText("approved");
    // "QA" twice over: the step this save removed, and where this route
    // used to point.
    expect(screen.getAllByText("QA")).toHaveLength(2);
    expect(screen.getByText("Done")).toBeTruthy();
  });

  /**
   * The edit the first draft of this screen was silent about: a route
   * whose target did not move. A version is an immutable route set, so
   * renaming a button is a change, and "View changes" has to show it.
   */
  it("says what a route edit did that was not about where it goes", async () => {
    mockIpc();
    renderChanges();

    await screen.findByText("label");
    expect(screen.getByText("Approve")).toBeTruthy();
    expect(screen.getByText("Ship it")).toBeTruthy();
  });

  it("offers nothing that writes and nothing to type into — only the way to the assistant", async () => {
    mockIpc();
    const ask = vi.fn();
    renderChanges(pipelineChangesPath("default"), ask);

    await screen.findByText("instructionsSummary");
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Ask the assistant"]);
    for (const role of ["textbox", "combobox", "checkbox", "switch", "spinbutton", "radio"]) expect(screen.queryAllByRole(role)).toEqual([]);
    for (const word of [/publish/i, /restore/i, /discard/i]) expect(screen.queryByRole("button", { name: word })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask the assistant" }));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("names the pipeline, and the two versions with who saved each", async () => {
    mockIpc();
    renderChanges();

    expect(await screen.findByText("Delivery — changes")).toBeInTheDocument();
    const compared = await screen.findByTestId("compared");
    expect(compared).toHaveTextContent("v1");
    expect(compared).toHaveTextContent("EO");
    expect(compared).toHaveTextContent("v2");
    expect(compared).toHaveTextContent("Dana");
  });

  it("says so when there is only one version to look at", async () => {
    mockIpc({ versions: [ANSWER.versions[0]], diff: null });
    renderChanges();

    await screen.findByText("This pipeline has one version, so there is nothing to compare it with.");
  });

  it("compares the versions its address names", async () => {
    const invoke = mockIpc();
    renderChanges(pipelineChangesPath("default", { kind: "versions", from: 1, to: 2 }));

    await screen.findByText("instructionsSummary");
    expect(versionsAsked(invoke)).toEqual([{ pipelineId: "default", from: 1, to: 2 }]);
  });

  it("asks for the newest two when its address names none", async () => {
    const invoke = mockIpc();
    renderChanges("/pipelines/default/changes");

    await screen.findByText("instructionsSummary");
    expect(versionsAsked(invoke)).toEqual([{ pipelineId: "default" }]);
  });

  it("ignores a version in the address that is not a number", async () => {
    const invoke = mockIpc();
    renderChanges("/pipelines/default/changes?from=first&to=2");

    await screen.findByText("instructionsSummary");
    expect(versionsAsked(invoke)).toEqual([{ pipelineId: "default", to: 2 }]);
  });
});

/**
 * *Compare*, on a pipeline this machine has diverged (EO-331,
 * `ARCHITECTURE.md`, "Divergence and suggestions").
 *
 * The first of the diverged state's three actions, and the one a person
 * presses *before* deciding between the other two. What it has to show
 * is not in the version history and never will be: a diverged copy
 * files no version, so the local edit exists only in the live graph and
 * arrives here as `local`.
 */
describe("the diff a person's own edits make", () => {
  const LOCAL = {
    basedOn: 6,
    diff: {
      from: 6,
      to: 6,
      steps: [{ stepId: "review", name: "Second opinion", change: "changed" as const, fields: [{ field: "name", before: "Review", after: "Second opinion" }] }],
      routes: [],
    },
  };

  it("draws them even where the organisation has published only one version", async () => {
    // The exact case the history is silent about — one version, no
    // diff — and the one a person meets first, because they diverged
    // and edited before anybody published again.
    mockIpc({ versions: [ANSWER.versions[0]], diff: null, local: LOCAL });
    renderChanges();

    expect(await screen.findByTestId("local-changes")).toBeInTheDocument();
    expect(screen.getAllByText("Second opinion").length).toBeGreaterThan(0);
    expect(screen.getByText("Review")).toBeInTheDocument();
    // And it says whose they are and what happens to them, because the
    // next thing the person does is suggest them or throw them away.
    expect(screen.getByText(/published nowhere until you suggest it/)).toBeInTheDocument();
    // Not the old sentence, which would have been the screen denying
    // the change it is drawing.
    expect(screen.queryByText("This pipeline has one version, so there is nothing to compare it with.")).toBeNull();
  });

  it("keeps the organisation's history beside them, under its own heading", async () => {
    mockIpc({ ...ANSWER, local: LOCAL });
    renderChanges();

    expect(await screen.findByTestId("local-changes")).toBeInTheDocument();
    expect(screen.getByText("Your edits")).toBeInTheDocument();
    expect(screen.getByText("What your organisation published")).toBeInTheDocument();
  });

  it("draws nothing of the sort on a pipeline nobody here has diverged", async () => {
    mockIpc();
    renderChanges();

    await screen.findByText("instructionsSummary");
    expect(screen.queryByTestId("local-changes")).toBeNull();
  });

  it("draws only them when opened on this machine's edits, as the diverged chip opens it", async () => {
    mockIpc({ ...ANSWER, local: LOCAL });
    renderChanges(pipelineChangesPath("default", { kind: "local" }));

    expect(await screen.findByTestId("local-changes")).toBeInTheDocument();
    expect(screen.queryByText("What your organisation published")).toBeNull();
    expect(screen.queryByText("instructionsSummary")).toBeNull();
    // Discarding is the assistant's card to offer now, not a screen's button.
    expect(screen.getByText(/ask the assistant to discard your edits/)).toBeInTheDocument();
    expect(screen.queryByText(/configuration/)).toBeNull();
  });

  it("says there is nothing of yours when opened on edits this machine does not have", async () => {
    mockIpc({ ...ANSWER, local: null });
    renderChanges(pipelineChangesPath("default", { kind: "local" }));

    expect(await screen.findByText(/This machine has no edits of its own to this pipeline/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("local-changes")).toBeNull());
  });

  /**
   * Open beside the assistant, whose card discards the edits it is
   * drawing (EO-521). Once the configuration push arrives the view says
   * there is nothing of yours, rather than going on showing edits that no
   * longer exist while `view_current` describes the live comparison.
   */
  it("stops drawing edits discarded while it is open, once the configuration push arrives", async () => {
    const listeners: (() => void)[] = [];
    window.eo.ipc.subscribe = vi.fn((channel: string, listener: () => void) => {
      if (channel === "config:changed") listeners.push(listener);
      return () => {};
    }) as never;
    const world: { local: typeof LOCAL | null } = { local: LOCAL };
    window.eo.ipc.invoke = vi.fn(async (channel: string) =>
      channel === "pipeline:versions" ? { ok: true, data: { ...ANSWER, local: world.local } } : { ok: true, data: {} },
    ) as never;
    renderChanges(pipelineChangesPath("default", { kind: "local" }));
    expect(await screen.findByTestId("local-changes")).toBeInTheDocument();

    world.local = null;
    act(() => listeners.forEach((listener) => listener()));

    expect(await screen.findByText(/This machine has no edits of its own to this pipeline/)).toBeInTheDocument();
    expect(screen.queryByTestId("local-changes")).toBeNull();
  });
});

describe("a version a template update wrote (EO-536)", () => {
  const BY_TEMPLATE = {
    ...ANSWER,
    versions: [
      ANSWER.versions[0],
      { id: "v2", pipelineId: "default", number: 2, createdAt: 2, createdBy: "template:software-feature-to-merge@1.1", createdByName: "the software-feature-to-merge 1.1 template update" },
    ],
  };

  it("is labelled as one, with the template and version that wrote it", async () => {
    mockIpc(BY_TEMPLATE);
    renderChanges();

    const compared = await screen.findByTestId("compared");
    await waitFor(() => expect(compared).toHaveTextContent("Template update"));
    expect(compared).toHaveTextContent("software-feature-to-merge v1.1");
    expect(screen.getAllByText("Template update")).toHaveLength(1);
  });

  it("leaves a person's version and EO's own unlabelled", async () => {
    mockIpc();
    renderChanges();

    const compared = await screen.findByTestId("compared");
    await waitFor(() => expect(compared).toHaveTextContent("Dana"));
    expect(compared).not.toHaveTextContent("Template update");
  });
});
