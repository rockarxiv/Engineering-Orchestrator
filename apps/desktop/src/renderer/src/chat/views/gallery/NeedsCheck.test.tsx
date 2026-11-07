import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import { GIT_WORKTREE_KIND, sectionLockedLine } from "@eo/core";
import type { GalleryNeedView, GalleryTemplateView, RuntimeStatusView, SectionLock } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { absent, signedOut } from "../agents/testRuntimes";
import { NeedsCheck } from "./NeedsCheck";
import DEVELOPER_FIRST_RUN from "./__fixtures__/developerFirstRun.json" with { type: "json" };

/**
 * The chat layout's needs check — `gallery/NeedsCheck.test.tsx`, held to
 * the same claims.
 *
 * The needs check, as a person meets it (EO-317,
 * `ARCHITECTURE.md`, "The needs check", "What a person sees first").
 *
 * The main process decides what each line says and what would fix it
 * (`needs.test.ts`); what is asserted here is the half a person touches.
 * Three claims, and each is one the story names:
 *
 *  - a red line about a missing folder **shows the path** and carries a
 *    "Choose folder" button, and pressing it turns the line green
 *    **without leaving the screen** — and the same of the role line
 *    every import leaves behind;
 *  - "Continue with Preview only" lands on the board the rehearsal is
 *    on, with nothing real filed;
 *  - with every line green and a job to fire, the button starts the
 *    first item — which is step 6, and the whole argument of the first
 *    ten minutes.
 */

const WEEKLY: GalleryTemplateView = {
  slug: "weekly-report",
  token: "weekly-v1",
  title: "Weekly report",
  description: "Every week, EO reads a folder and writes the report.",
  version: "1.0",
  source: "Bundled with EO",
  bundled: true,
  pipelineName: "Weekly report",
  needs: [],
  blanks: [],
  roleSlots: [],
  solo: true,
  previewable: true,
};

const MISSING_FOLDER: GalleryNeedView = {
  key: "workspace",
  line: "A folder — somewhere its work happens",
  met: false,
  why: "/home/anna/reports does not exist, so it cannot be a folder workspace.",
  fix: { kind: "folder", label: "Choose folder", target: "/home/anna/reports" },
};

const NO_BACKEND: GalleryNeedView = {
  key: "backend",
  line: "A coding agent signed in",
  met: false,
  why: "Nothing on this machine is signed in, and this pack was built on claude.",
  fix: { kind: "backend", label: "Sign in", target: "claude" },
};

/**
 * The line the weekly report lands with once something is signed in: its
 * `reporter` agent exists, points at nothing, and is switched off.
 */
const UNSTAFFED_ROLE: GalleryNeedView = {
  key: "role:reporter",
  line: "An agent for the Reporter steps",
  met: false,
  why: "The Reporter steps have no agent to run on yet.",
  fix: { kind: "role", label: "Use Claude Code for these steps", target: "reporter" },
};

const GREEN: GalleryNeedView[] = [
  { key: "workspace", line: "A folder — somewhere its work happens", met: true, why: null, fix: null },
  { key: "backend", line: "A coding agent signed in", met: true, why: null, fix: null },
];

function mockIpc(options: {
  needs: GalleryNeedView[];
  onceFixed?: GalleryNeedView[];
  jobId?: string | null;
  attachProblem?: string | null;
  staffProblem?: string | null;
  /** The organisation publishes its agents, and this press would have created one (EO-329). */
  staffLocked?: SectionLock;
  /** What `runtime:status` answers, by provider. Nothing at all when absent. */
  runtimes?: RuntimeStatusView[];
  /** What `modules:list` answers. Only the fields the module line reads are filled. */
  modules?: unknown[];
  /** What `repositories:list` and `projects:list` answer, for "Add another repository". */
  repositories?: { id: string; name: string }[];
  projectRepositoryIds?: string[];
}) {
  // What the *machine* would say, before and after the folder is
  // attached — rather than a queue of answers keyed to how many times
  // the screen happened to ask. The screen draws from `initialData` and
  // fetches when something invalidates it, so counting reads would be
  // asserting about the cache rather than about the fix.
  let fixed = false;
  const invoke = vi.fn(async (channel: string, _payload?: unknown) => {
    switch (channel) {
      case "gallery:needs":
        return { ok: true, data: { needs: fixed ? (options.onceFixed ?? options.needs) : options.needs, jobId: options.jobId ?? null, problem: null } };
      case "gallery:attachWorkspace":
        if (options.attachProblem == null) fixed = true;
        return { ok: true, data: { ok: options.attachProblem == null, problem: options.attachProblem ?? null } };
      case "workspaces:create":
        fixed = true;
        return { ok: true, data: { ok: true, workspace: null, problem: null } };
      case "projects:addProject":
        fixed = true;
        return { ok: true, data: { ok: true, project: null, problem: null } };
      case "repositories:list":
        return { ok: true, data: { repositories: options.repositories ?? [] } };
      case "projects:list":
        return { ok: true, data: { projects: [{ id: "p1", name: "Shop", repositoryIds: options.projectRepositoryIds ?? [] }], archivedProjects: [], activeProjectId: "p1" } };
      case "gallery:staffRole":
        if (options.staffLocked !== undefined) {
          // What the main process answers when the organisation
          // publishes its agents and this press would have created one
          // (EO-329): the design's own words, and the marker beside them.
          return {
            ok: true,
            data: { ok: false, problem: sectionLockedLine(options.staffLocked), locked: options.staffLocked },
          };
        }
        if (options.staffProblem == null) fixed = true;
        return { ok: true, data: { ok: options.staffProblem == null, problem: options.staffProblem ?? null, locked: null } };
      case "gallery:preview":
        return { ok: true, data: { itemId: "preview-1", projectId: "p-preview", pipelineId: "preview-pl", problem: null } };
      case "jobs:runNow":
        return { ok: true, data: { fired: true, occurrence: null, itemId: "item-1", problem: null } };
      case "runtime:status": {
        const provider = (_payload as { provider: string }).provider;
        return { ok: true, data: { runtime: options.runtimes?.find((runtime) => runtime.id === provider) ?? null } };
      }
      case "runtime:describe":
        return { ok: true, data: { unpackedBytes: 1_000_000, sourceUrl: null, problem: null } };
      case "runtime:install":
        return { ok: true, data: { ok: true, runtime: null, problem: null } };
      case "modules:list":
        return { ok: true, data: { modules: options.modules ?? [] } };
      case "modules:approve":
        fixed = true;
        return { ok: true, data: { approved: true, problem: null, lineCoverage: 100, coverageAcknowledgementNeeded: false, machineSpecific: [] } };
      case "dialog:pickDirectory":
        return { ok: true, data: { path: "/home/anna/elsewhere" } };
      default:
        return { ok: true, data: {} };
    }
  });
  window.eo.ipc.invoke = invoke as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  return invoke;
}

function Item() {
  const { itemId } = useParams();
  return <span data-testid="item-page">{itemId}</span>;
}

/** Stands in for the board, and says which pipeline it was asked for. */
function Board() {
  const { pipelineId } = useParams();
  return <span data-testid="board">{pipelineId}</span>;
}

function renderNeeds(needs: GalleryNeedView[], overrides: { jobId?: string | null; onFinished?: () => void; template?: GalleryTemplateView } = {}) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/gallery"]}>
          <Routes>
            <Route
              path="/gallery"
              element={
                <NeedsCheck
                  template={overrides.template ?? WEEKLY}
                  projectId="p1"
                  pipelineId="pl1"
                  needs={needs}
                  jobId={overrides.jobId ?? null}
                  onFinished={overrides.onFinished ?? (() => {})}
                />
              }
            />
            <Route path="/items/:itemId" element={<Item />} />
            <Route path="/pipelines/:pipelineId" element={<Board />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("a red line", () => {
  it("says why, names the path, and carries the one button that fixes it", async () => {
    mockIpc({ needs: [MISSING_FOLDER, NO_BACKEND] });
    renderNeeds([MISSING_FOLDER, NO_BACKEND]);

    expect(await screen.findByText("A folder — somewhere its work happens")).toBeInTheDocument();
    expect(screen.getByText("/home/anna/reports does not exist, so it cannot be a folder workspace.")).toBeInTheDocument();
    // The path is in the field as well as in the sentence, because the
    // field is what the fix replaces.
    expect(screen.getByLabelText("Folder path")).toHaveValue("/home/anna/reports");
    expect(screen.getByRole("button", { name: "Choose folder" })).toBeInTheDocument();
  });

  /** The acceptance criterion: "fixing it turns the line green without leaving the screen". */
  it("turns green where it is, when the folder is chosen", async () => {
    const invoke = mockIpc({ needs: [MISSING_FOLDER, NO_BACKEND], onceFixed: GREEN });
    renderNeeds([MISSING_FOLDER, NO_BACKEND]);

    fireEvent.change(await screen.findByLabelText("Folder path"), { target: { value: "/home/anna/elsewhere" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(invoke.mock.calls.some((call: unknown[]) => call[0] === "gallery:attachWorkspace")).toBe(true));
    expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "gallery:attachWorkspace")?.[1]).toEqual({
      projectId: "p1",
      path: "/home/anna/elsewhere",
      kind: "folder",
    });

    // Still on the needs check, and the line is no longer red: the
    // screen asked the machine again rather than patching what it drew.
    await waitFor(() => expect(screen.queryByLabelText("Folder path")).not.toBeInTheDocument());
    expect(screen.getByText("Weekly report is set up")).toBeInTheDocument();
    expect(screen.queryByText("/home/anna/reports does not exist, so it cannot be a folder workspace.")).not.toBeInTheDocument();
  });

  it("says what the main process refused, rather than going quiet", async () => {
    mockIpc({ needs: [MISSING_FOLDER], attachProblem: "/nowhere does not exist." });
    renderNeeds([MISSING_FOLDER]);

    fireEvent.change(await screen.findByLabelText("Folder path"), { target: { value: "/nowhere" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("/nowhere does not exist.")).toBeInTheDocument();
  });

  /**
   * The line an import always leaves behind, and the button that clears
   * it (ARCHITECTURE.md, "The needs check").
   *
   * A pack's role names no backend, so the agent it brings lands pointed
   * at nothing; signing in does not move the line, because the row is
   * what is unpointed. Before this the screen offered a sentence about
   * the Agents screen — an instruction wearing a button's clothes — and
   * the weekly report could never reach the state in which EO starts its
   * first item.
   */
  it("staffs a role in place, and the line goes green where it is", async () => {
    const invoke = mockIpc({ needs: [UNSTAFFED_ROLE], onceFixed: GREEN });
    renderNeeds([UNSTAFFED_ROLE]);

    fireEvent.click(await screen.findByRole("button", { name: "Use Claude Code for these steps" }));

    await waitFor(() => expect(invoke.mock.calls.some((call: unknown[]) => call[0] === "gallery:staffRole")).toBe(true));
    expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "gallery:staffRole")?.[1]).toEqual({
      slug: "weekly-report",
      token: "weekly-v1",
      role: "reporter",
    });

    await waitFor(() => expect(screen.queryByRole("button", { name: "Use Claude Code for these steps" })).not.toBeInTheDocument());
    expect(screen.getByText("Weekly report is set up")).toBeInTheDocument();
  });

  it("says why the main process would not staff it, rather than going quiet", async () => {
    mockIpc({ needs: [UNSTAFFED_ROLE], staffProblem: "Nothing on this machine is signed in." });
    renderNeeds([UNSTAFFED_ROLE]);

    fireEvent.click(await screen.findByRole("button", { name: "Use Claude Code for these steps" }));

    expect(await screen.findByText("Nothing on this machine is signed in.")).toBeInTheDocument();
  });

  /**
   * The lock, in the words it is owed (EO-329, ARCHITECTURE.md, "Publish, lock and versions",
   * review).
   *
   * A locked agents section refuses the branch of this button that
   * would *create* an agent, and the refusal it writes for the command
   * layer is addressed to an assistant: "tell the person it is managed
   * and stop". This screen answers a person, and what a person is owed
   * is the lock text — what is managed, and what stays theirs.
   */
  it("draws the lock rather than the sentence written for an assistant", async () => {
    mockIpc({ needs: [UNSTAFFED_ROLE], staffLocked: { locked: true, section: "agents", publishedBy: "Dana" } });
    renderNeeds([UNSTAFFED_ROLE]);

    fireEvent.click(await screen.findByRole("button", { name: "Use Claude Code for these steps" }));

    const lock = await screen.findByTestId("managed-lock-agents");
    expect(lock).toHaveTextContent("Steps, routes and prompts are managed by your organisation.");
    expect(lock).toHaveTextContent("Your sign-ins, local folders and personal secrets are yours.");
    expect(lock).toHaveTextContent("Published by Dana.");
    // Never the transcript's sentence, and never as red text: this is a
    // lock, not something the person did wrong.
    expect(screen.queryByText(/Tell the person it is managed and stop/)).toBeNull();
  });

  /**
   * EO ships no runtime, so a machine with none installed has nothing to
   * sign into — and is told so rather than handed a button that would
   * open an empty dialog (invariant #12).
   */
  it("does not offer a sign-in this machine has nothing behind", async () => {
    mockIpc({ needs: [NO_BACKEND] });
    renderNeeds([NO_BACKEND]);

    expect(await screen.findByText(/No coding agent is installed on this machine yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Sign in/ })).not.toBeInTheDocument();
  });

  /**
   * And it offers the install instead, in place (EO-659): the panel first
   * run's connect step draws, on the channel Agents → Runtimes uses — and
   * never a sentence pointing at Agents → Runtimes, which first run hides.
   */
  it("opens the install-and-sign-in panel in place when nothing is installed", async () => {
    const invoke = mockIpc({ needs: [NO_BACKEND], runtimes: [absent("codex", "Codex"), absent("claude", "Claude Code")] });
    renderNeeds([NO_BACKEND]);

    fireEvent.click(await screen.findByRole("button", { name: "Install a coding agent" }));
    expect(await screen.findByRole("list", { name: "Coding agents" })).toBeInTheDocument();
    expect(screen.queryByText(/Agents → Runtimes/)).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Install Claude Code" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    await waitFor(() => expect(invoke.mock.calls.some((call: unknown[]) => call[0] === "runtime:install")).toBe(true));
    expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "runtime:install")?.[1]).toEqual({ provider: "claude" });
  });

  it("offers the sign-in once a runtime is installed", async () => {
    mockIpc({ needs: [NO_BACKEND], runtimes: [absent("codex", "Codex"), signedOut("claude", "Claude Code")] });
    renderNeeds([NO_BACKEND]);

    expect(await screen.findByRole("button", { name: "Sign in to Claude Code" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install a coding agent" })).toBeNull();
  });
});

/**
 * A module the pack brought, read and approved here (EO-659) rather than
 * in Settings → Modules, which first run hides.
 */
describe("a module to approve", () => {
  const MODULE_LINE: GalleryNeedView = {
    key: "module:m1",
    line: "Post it — a module, read and approved",
    met: false,
    why: "A module is code from somebody else's machine. EO runs none of it until you have read it and approved it.",
    fix: { kind: "module", label: "Read and approve", target: "m1" },
  };
  const POST_IT = {
    id: "m1",
    slug: "post",
    name: "Post it",
    description: "Puts the approved report where people read it.",
    code: "export default async function run() { return { result: 'posted' }; }",
    manifest: { needs: { bin: [], env: [], network: true, item: false, comment: false, attach: false, create: false }, results: ["posted"] },
    approvedAt: null,
  };

  it("shows the code and approves it in place, and the line goes green", async () => {
    const invoke = mockIpc({ needs: [MODULE_LINE], onceFixed: [{ ...MODULE_LINE, met: true, why: null, fix: null }], modules: [POST_IT] });
    renderNeeds([MODULE_LINE]);

    expect(screen.queryByText(/Settings/)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Read and approve" }));
    expect(await screen.findByLabelText("Code of Post it")).toHaveTextContent("export default async function run()");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "modules:approve")?.[1]).toEqual({ id: "m1", acknowledgeLowCoverage: false }));
    expect(await screen.findByText("Everything it needs is here.")).toBeInTheDocument();
  });
});

describe("the two ways out", () => {
  /**
   * "Continue with Preview only" — the design's exit for somebody who cannot
   * get a line green.
   *
   * Onto the **board** the rehearsal is on, which is what the story
   * says: the columns with the marked card in them, rather than the
   * item's own page. The window is pointed at the preview project on the
   * way, because a board draws the project it is looking at and the
   * rehearsal lives in EO's own.
   */
  it("rehearses the pack and lands on the board it is on, with nothing real filed", async () => {
    const invoke = mockIpc({ needs: [MISSING_FOLDER, NO_BACKEND] });
    const finished = vi.fn();
    renderNeeds([MISSING_FOLDER, NO_BACKEND], { onFinished: finished });

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Preview only" }));

    expect(await screen.findByTestId("board")).toHaveTextContent("preview-pl");
    expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "gallery:preview")?.[1]).toEqual({ slug: "weekly-report", token: "weekly-v1" });
    expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "projects:setActive")?.[1]).toEqual({ id: "p-preview" });
    // Nothing real: no job was fired and no item filed on their own
    // project.
    expect(invoke.mock.calls.some((call: unknown[]) => call[0] === "jobs:runNow")).toBe(false);
    // And first run is behind them, so this exit is not a loop back to
    // step 1 on the next launch.
    expect(finished).toHaveBeenCalled();
  });

  /**
   * Step 6: "the first item runs, and they watch it."
   *
   * Offered only with every line green — "nothing real runs until every
   * line is green" — and only where the template files work on a
   * schedule, because the job is what a first item comes out of.
   */
  it("starts the first item when everything is green, and opens it", async () => {
    const invoke = mockIpc({ needs: GREEN, jobId: "job-1" });
    const finished = vi.fn();
    renderNeeds(GREEN, { jobId: "job-1", onFinished: finished });

    fireEvent.click(await screen.findByRole("button", { name: /^Start the first/ }));

    expect(await screen.findByTestId("item-page")).toHaveTextContent("item-1");
    expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "jobs:runNow")?.[1]).toEqual({ jobId: "job-1" });
    expect(finished).toHaveBeenCalled();
  });

  it("offers the board instead while a line is still red", async () => {
    mockIpc({ needs: [MISSING_FOLDER], jobId: "job-1" });
    renderNeeds([MISSING_FOLDER], { jobId: "job-1" });

    expect(await screen.findByRole("button", { name: "Go to the board" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Start the first/ })).not.toBeInTheDocument();
  });

  /**
   * And a template that files nothing on a schedule has no first item to
   * start — which is the developer's first run, and the reason the board
   * is always the other button.
   */
  it("offers the board when the template made no job, even with everything green", async () => {
    mockIpc({ needs: GREEN, jobId: null });
    renderNeeds(GREEN);

    fireEvent.click(await screen.findByRole("button", { name: "Go to the board" }));
    expect(await screen.findByTestId("board")).toBeInTheDocument();
  });
});

/**
 * A project that spans several repositories (EO-662): every one by name
 * with its own status, the line green while one works, and another added
 * the way Settings → Projects adds one.
 */
describe("several repositories", () => {
  const DEVELOPER: GalleryTemplateView = { ...WEEKLY, slug: "software-feature-to-merge", token: "software-v1", title: "Software feature to merge" };
  const line = "A repository — the checkout its work happens in";
  const ONE_OF_TWO: GalleryNeedView = {
    key: "workspace",
    line,
    met: true,
    why: null,
    fix: { kind: "addRepository", label: "Add another repository", target: null },
    parts: [
      { key: "w1", line: "shop", met: true, why: null },
      { key: "w2", line: "payments", met: false, why: "/home/anna/code/payments does not exist, so it cannot be a repository." },
    ],
  };
  const BOTH: GalleryNeedView = {
    ...ONE_OF_TWO,
    parts: [
      { key: "w1", line: "shop", met: true, why: null },
      { key: "w3", line: "docs", met: true, why: null },
    ],
  };

  it("lists each repository with its own status, and stays green with one missing", async () => {
    mockIpc({ needs: [ONE_OF_TWO] });
    renderNeeds([ONE_OF_TWO], { template: DEVELOPER });

    expect(await screen.findByText("Everything it needs is here.")).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: `What "${line}" counts` }));
    expect(rows.getByText("shop")).toBeInTheDocument();
    expect(rows.getByText("payments")).toBeInTheDocument();
    expect(rows.getByText("/home/anna/code/payments does not exist, so it cannot be a repository.")).toBeInTheDocument();
    expect(rows.getAllByLabelText("Ready")).toHaveLength(1);
    expect(rows.getAllByLabelText("Not ready")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add another repository" })).toBeInTheDocument();
  });

  it("attaches another through workspaces:create, onto this project, and draws it where it is", async () => {
    const invoke = mockIpc({ needs: [ONE_OF_TWO], onceFixed: [BOTH] });
    renderNeeds([ONE_OF_TWO], { template: DEVELOPER });

    fireEvent.click(await screen.findByRole("button", { name: "Add another repository" }));
    fireEvent.change(screen.getByLabelText("Repository path"), { target: { value: "/home/anna/code/docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(invoke.mock.calls.some((call: unknown[]) => call[0] === "workspaces:create")).toBe(true));
    expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "workspaces:create")?.[1]).toMatchObject({
      kind: GIT_WORKTREE_KIND,
      projectId: "p1",
      config: { name: "docs", repoPath: "/home/anna/code/docs" },
    });
    // Asked again rather than patched: the new one is drawn, the form is gone.
    expect(await screen.findByText("docs")).toBeInTheDocument();
    expect(screen.queryByLabelText("Repository path")).not.toBeInTheDocument();
    expect(invoke.mock.calls.some((call: unknown[]) => call[0] === "gallery:attachWorkspace")).toBe(false);
  });

  it("adds one EO already holds through projects:addProject", async () => {
    const invoke = mockIpc({
      needs: [ONE_OF_TWO],
      onceFixed: [BOTH],
      repositories: [
        { id: "w1", name: "shop" },
        { id: "w3", name: "docs" },
      ],
      projectRepositoryIds: ["w1", "w2"],
    });
    renderNeeds([ONE_OF_TWO], { template: DEVELOPER });

    fireEvent.click(await screen.findByRole("button", { name: "Add another repository" }));
    // Only the one not already on this project is offered.
    fireEvent.click(await screen.findByRole("button", { name: "Add docs" }));
    expect(screen.queryByRole("button", { name: "Add shop" })).not.toBeInTheDocument();

    await waitFor(() => expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "projects:addProject")?.[1]).toEqual({ projectId: "p1", repositoryId: "w3" }));
    expect(await screen.findByText("docs")).toBeInTheDocument();
  });
});

/**
 * The developer's first run, word for word (EO-317).
 *
 * "A developer's fresh installation reaches the same board it reaches
 * today with the same two needs; a snapshot test proves the developer's
 * first-run copy."
 *
 * **The input is the real thing.** `developerFirstRun.json` is what
 * `gallery:needs` answers for a fresh installation of the bundled
 * developer pack, and `needs.test.ts` holds it there — same pack, same
 * preflight, same derivation, against a migrated database. A snapshot
 * fed by lines typed out here would have gone on passing while the
 * screen said something else, which is the one thing a snapshot of copy
 * must not do.
 */
describe("the developer's first-run copy", () => {
  const needs = DEVELOPER_FIRST_RUN.needs as GalleryNeedView[];
  const template: GalleryTemplateView = {
    ...WEEKLY,
    slug: DEVELOPER_FIRST_RUN.template.slug,
    token: "software-v1",
    title: DEVELOPER_FIRST_RUN.template.title,
    pipelineName: DEVELOPER_FIRST_RUN.template.pipelineName,
    previewable: DEVELOPER_FIRST_RUN.template.previewable,
  };

  it("asks for a repository and a backend, in these words", async () => {
    mockIpc({ needs, jobId: DEVELOPER_FIRST_RUN.jobId });
    const { container } = renderNeeds(needs, { template, jobId: DEVELOPER_FIRST_RUN.jobId });

    await screen.findByText("Software feature to merge is set up");
    // Word for word, and nowhere sending the person to a screen first
    // run hides (EO-659).
    expect(container.textContent).toBe(
      'Software feature to merge is set up2 things left before real work runs. Each one says why, and carries the one button that fixes it.An agent for the Implementer stepsAn agent for the Reviewer stepsA repository — the checkout its work happens inThis project has no repository yet, so nothing can be branched, reviewed or opened as a pull request.Choose a repositorySaveA coding agent signed inNothing on this machine is signed in, so no step would dispatch.No coding agent is installed on this machine yet. EO ships none, and can fetch one for you.Install a coding agentGo to the boardContinue with Preview only',
    );
  });

  /** The two red ones are the two the old first-run panel asked for, and no others. */
  it("has exactly two red lines", () => {
    expect(needs.filter((need) => !need.met).map((need) => need.key)).toEqual(["workspace", "backend"]);
  });
});
